import "./setup-env";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { DeleteMessageCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { Client } from "pg";
import {
  assertLedgerInvariant,
  brl,
  createWallet,
  DLQ_NAME,
  drain,
  ensureQueues,
  EVENTS_QUEUE_NAME,
  initOrm,
  pg,
  QUEUE_NAME,
  queueUrl,
  resetDb,
  sqsClient,
  startInstance,
  stopInstance,
  waitFor,
  type Instance,
} from "./helpers";
import { SubmitWagerTransactionUseCase } from "../../src/wagering/application/submit-wager-transaction.use-case";
import { CONSUMER_NAME, WagerQueueConsumer } from "../../src/messaging/infra/wager-queue.consumer";
import { PendingReferenceWorker } from "../../src/wagering/application/pending-reference.worker";
import { OutboxPublisher } from "../../src/messaging/infra/outbox.publisher";
import { SqsEventPublisher, type EventPublisherPort } from "../../src/messaging/infra/event-publisher";

const msg = (messageId: string, data: Record<string, unknown>) =>
  JSON.stringify({ messageId, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(), data });

const bet = (w: { id: string; playerId: string }, ext: string, amount = "10.00", kind = "BET") => ({
  providerId: "provider-a",
  externalTransactionId: ext,
  idempotencyKey: `provider-a:${ext}`,
  playerId: w.playerId,
  walletId: w.id,
  roundId: "round-1",
  gameId: "fortune-chimp",
  kind,
  money: brl(amount),
});

async function send(body: string, groupId: string) {
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: await queueUrl(QUEUE_NAME),
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: crypto.randomUUID(), // força o broker a entregar duplicatas: a INBOX deduplica
    }),
  );
}

/** Recebe a próxima mensagem cujo corpo contém `marker`; descarta lixo de execuções anteriores. */
async function receiveMatching(marker: string, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const res = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: await queueUrl(QUEUE_NAME),
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
      }),
    );
    let found;
    for (const m of res.Messages ?? []) {
      if (!found && m.Body?.includes(marker)) found = m;
      else if (!m.Body?.includes(marker)) {
        await sqsClient.send(new DeleteMessageCommand({ QueueUrl: await queueUrl(QUEUE_NAME), ReceiptHandle: m.ReceiptHandle }));
      }
    }
    if (found) return found;
  }
  throw new Error(`mensagem ${marker} não chegou`);
}

async function queueIsEmpty() {
  const r = await sqsClient.send(
    new GetQueueAttributesCommand({
      QueueUrl: await queueUrl(QUEUE_NAME),
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return Number(r.Attributes?.ApproximateNumberOfMessages) + Number(r.Attributes?.ApproximateNumberOfMessagesNotVisible) === 0;
}

describe("mensageria: inbox, outbox, retry e DLQ", () => {
  let orm: MikroORM;
  let c: Client;
  let app: Instance;

  beforeAll(async () => {
    orm = await initOrm();
    c = await pg();
    await resetDb(c);
    await ensureQueues();
    app = await startInstance(3401, { OUTBOX_PUBLISHER_ENABLED: "false" });
  });

  afterAll(async () => {
    await stopInstance(app);
    await c.end();
    await orm.close();
  });

  it("worker morre DEPOIS do commit e ANTES do ack → redelivery não duplica (inbox)", async () => {
    const { body: w } = await createWallet(app.url, "100.00");
    const useCase = new SubmitWagerTransactionUseCase(orm.em);
    await send(msg(`m-crash-${w.id}`, bet(w, `sqs-crash-${w.id}`, "30.00")), w.id);

    // 1ª entrega: commit acontece, mas o "processo morre" antes do DeleteMessage.
    const first = await receiveMatching(`m-crash-${w.id}`);
    const data = JSON.parse(first.Body!).data;
    await useCase.execute({ ...data, correlationId: "c1" }, { consumerName: CONSUMER_NAME, messageId: `m-crash-${w.id}` });

    // 2ª entrega da MESMA mensagem (visibilidade expirou): o consumidor real só faz ack.
    const consumer = new WagerQueueConsumer(useCase);
    const outcome = await consumer.handle(await queueUrl(QUEUE_NAME), first);
    expect(outcome).toBe("OK");

    const { rows } = await c.query(`select balance::text from wallets where id = $1`, [w.id]);
    expect(rows[0].balance).toBe("70.00");
    const inbox = await c.query(`select processed_at from inbox_messages where message_id = $1`, [`m-crash-${w.id}`]);
    expect(inbox.rows).toHaveLength(1);
    expect(inbox.rows[0].processed_at).not.toBeNull();
  });

  it("consumidor real (instância com SQS ligado): mensagem duplicada na fila → um único efeito e ack", async () => {
    const consumerApp = await startInstance(3402, { SQS_CONSUMER_ENABLED: "true", OUTBOX_PUBLISHER_ENABLED: "false" });
    try {
      const { body: w } = await createWallet(app.url, "50.00");
      const body = msg(`m-dup-${w.id}`, bet(w, `sqs-dup-${w.id}`, "20.00"));
      await send(body, w.id);
      await send(body, w.id);
      await waitFor(async () => {
        const r = await c.query(`select count(*)::int as n from inbox_messages where message_id = $1 and processed_at is not null`, [`m-dup-${w.id}`]);
        return r.rows[0].n === 1;
      });
      // Espera a 2ª cópia ser consumida (fila vazia) antes de conferir.
      await waitFor(() => queueIsEmpty(), 20000);
      const { rows } = await c.query(`select balance::text from wallets where id = $1`, [w.id]);
      expect(rows[0].balance).toBe("30.00");
      const debits = await c.query(`select count(*)::int as n from wallet_ledger_entries where wallet_id = $1 and direction = 'DEBIT'`, [w.id]);
      expect(debits.rows[0].n).toBe(1);
    } finally {
      await stopInstance(consumerApp); // SIGTERM: shutdown gracioso
    }
  });

  it("mensagem malformada vai para a DLQ e sai da fila principal", async () => {
    const marker = `bad-${crypto.randomUUID()}`;
    await send(`{isto não é json ${marker}`, "g-bad");
    const m = await receiveMatching(marker);
    const consumer = new WagerQueueConsumer(new SubmitWagerTransactionUseCase(orm.em));
    expect(await consumer.handle(await queueUrl(QUEUE_NAME), m)).toBe("PERMANENT");
    const dlq = await drain(DLQ_NAME);
    expect(dlq).toContain(`{isto não é json ${marker}`);
  });

  it("erro transitório: retry com backoff e, esgotado o limite, DLQ", async () => {
    const { body: w } = await createWallet(app.url, "10.00");
    await send(msg(`m-transient-${w.id}`, bet(w, `sqs-tr-${w.id}`)), w.id);
    // Use case que simula o banco fora do ar.
    const flaky = { execute: async () => { throw Object.assign(new Error("connection refused"), { code: "08006" }); } };
    const consumer = new WagerQueueConsumer(flaky as unknown as SubmitWagerTransactionUseCase);
    (consumer as unknown as { maxReceives: number }).maxReceives = 2;

    const first = await receiveMatching(`m-transient-${w.id}`);
    expect(await consumer.handle(await queueUrl(QUEUE_NAME), first)).toBe("TRANSIENT"); // volta em 2s
    const second = await receiveMatching(`m-transient-${w.id}`, 15000);
    expect(Number(second.Attributes?.ApproximateReceiveCount)).toBeGreaterThanOrEqual(2);
    expect(await consumer.handle(await queueUrl(QUEUE_NAME), second)).toBe("PERMANENT");
    expect((await drain(DLQ_NAME)).some((b) => b.includes(`m-transient-${w.id}`))).toBe(true);
    // Nada foi aplicado.
    const { rows } = await c.query(`select count(*)::int as n from wager_transactions where external_transaction_id = $1`, [`sqs-tr-${w.id}`]);
    expect(rows[0].n).toBe(0);
  });

  it("atomicidade: rejeição de negócio grava transação + inbox + outbox, sem saldo nem ledger", async () => {
    const { body: w } = await createWallet(app.url, "5.00");
    const useCase = new SubmitWagerTransactionUseCase(orm.em);
    const r = await useCase.execute({ ...bet(w, `atom-${w.id}`, "9.00"), correlationId: "c" }, { consumerName: CONSUMER_NAME, messageId: `m-atom-${w.id}` });
    expect(String(r.failureCode)).toBe("INSUFFICIENT_FUNDS");
    const tx = await c.query(`select status from wager_transactions where id = $1`, [r.transactionId]);
    const ledger = await c.query(`select count(*)::int as n from wallet_ledger_entries where transaction_id = $1`, [r.transactionId]);
    const outbox = await c.query(`select event_type from outbox_messages where aggregate_id = $1`, [r.transactionId]);
    const inbox = await c.query(`select 1 from inbox_messages where message_id = $1`, [`m-atom-${w.id}`]);
    expect(tx.rows[0].status).toBe("REJECTED");
    expect(ledger.rows[0].n).toBe(0);
    expect(outbox.rows.map((x: { event_type: string }) => x.event_type)).toEqual(["WagerTransactionRejected"]);
    expect(inbox.rows).toHaveLength(1);
  });

  it("dois publishers concorrentes sobre a mesma outbox → cada evento publicado uma vez", async () => {
    await c.query(`update outbox_messages set published_at = now() where published_at is null`);
    const { body: w } = await createWallet(app.url, "1000.00");
    const useCase = new SubmitWagerTransactionUseCase(orm.em);
    for (let i = 0; i < 20; i++) await useCase.execute({ ...bet(w, `ob-${i}-${w.id}`, "1.00"), correlationId: "c" });
    const pending = (await c.query(`select count(*)::int as n from outbox_messages where published_at is null`)).rows[0].n;
    expect(pending).toBe(41); // OPENING (BalanceChanged) + Processed e BalanceChanged por aposta

    const published: string[] = [];
    const slow: EventPublisherPort = {
      async publish(m) {
        await Bun.sleep(5);
        published.push(m.id);
      },
    };
    const a = new OutboxPublisher(orm.em, slow);
    const b = new OutboxPublisher(orm.em, slow);
    while ((await c.query(`select count(*)::int as n from outbox_messages where published_at is null`)).rows[0].n > 0) {
      await Promise.all([a.tick(7), b.tick(7)]);
    }
    expect(published).toHaveLength(41);
    expect(new Set(published).size).toBe(41);
  });

  it("commit confirmado e processo morre antes de publicar → outra instância publica no SQS", async () => {
    await c.query(`update outbox_messages set published_at = now() where published_at is null`);
    await drain(EVENTS_QUEUE_NAME, 0);
    const { body: w } = await createWallet(app.url, "10.00"); // OPENING → WalletBalanceChanged pendente
    // A instância `app` tem o publisher DESLIGADO: simula quem commitou e morreu.
    const other = new OutboxPublisher(orm.em, new SqsEventPublisher());
    expect(await other.tick()).toBe(1);
    const events = (await drain(EVENTS_QUEUE_NAME)).map((b) => JSON.parse(b));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "WalletBalanceChanged", aggregateId: w.id, version: 1 });
    expect(events[0].data.balanceAfter).toEqual(brl("10.00"));
  });

  it("falha ao publicar agenda retry com backoff, sem perder o evento", async () => {
    await c.query(`update outbox_messages set published_at = now() where published_at is null`);
    await createWallet(app.url, "1.00");
    const broken: EventPublisherPort = { publish: async () => { throw new Error("sqs down"); } };
    expect(await new OutboxPublisher(orm.em, broken).tick()).toBe(0);
    const { rows } = await c.query(`select attempts, next_attempt_at > now() as later from outbox_messages where published_at is null`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempts: 1, later: true });
  });

  it("referência que nunca chega: worker esgota as tentativas → REJECTED com REFERENCE_NOT_FOUND + evento", async () => {
    const { body: w } = await createWallet(app.url, "10.00");
    const useCase = new SubmitWagerTransactionUseCase(orm.em);
    const r = await useCase.execute({
      ...bet(w, `orphan-${w.id}`, "5.00", "REFUND"),
      referenceExternalTransactionId: `nunca-existiu-${w.id}`,
      correlationId: "c",
    });
    expect(String(r.status)).toBe("PENDING_REFERENCE");
    const worker = new PendingReferenceWorker(orm.em);
    for (let i = 0; i < 20; i++) {
      // Adianta o relógio do backoff para o teste ser determinístico.
      await c.query(`update wager_transactions set next_attempt_at = now() where id = $1 and status = 'PENDING_REFERENCE'`, [r.transactionId]);
      await worker.tick();
      const { rows } = await c.query(`select status, failure_code, attempts from wager_transactions where id = $1`, [r.transactionId]);
      if (rows[0].status !== "PENDING_REFERENCE") break;
    }
    const { rows } = await c.query(`select status, failure_code from wager_transactions where id = $1`, [r.transactionId]);
    expect(rows[0]).toEqual({ status: "REJECTED", failure_code: "REFERENCE_NOT_FOUND" });
    const events = await c.query(`select event_type from outbox_messages where aggregate_id = $1 order by occurred_at`, [r.transactionId]);
    expect(events.rows.map((e: { event_type: string }) => e.event_type)).toEqual(["WagerTransactionPendingReference", "WagerTransactionRejected"]);
    const bal = await c.query(`select balance::text from wallets where id = $1`, [w.id]);
    expect(bal.rows[0].balance).toBe("10.00");
  });

  it("invariante final: wallet.balance == saldo reconstruído pelo ledger", async () => {
    expect(await assertLedgerInvariant(c)).toEqual([]);
  });
});
