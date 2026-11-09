/**
 * Infra dos testes de integração: PostgreSQL e SQS (LocalStack/MiniStack) REAIS.
 * Nada de mocks de banco ou fila. Suba antes: docker compose up -d postgres localstack
 */
import "./setup-env";
import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import { CreateQueueCommand, DeleteMessageCommand, GetQueueAttributesCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import type { Subprocess } from "bun";
import { Client } from "pg";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://wagering:wagering@localhost:5432/wagering_test";
process.env.DATABASE_URL = TEST_DB_URL;
process.env.AWS_ENDPOINT ??= "http://127.0.0.1:4566";
// Ambientes com proxy HTTP: chamadas locais (LocalStack/instâncias) não passam por ele.
process.env.NO_PROXY = process.env.no_proxy = ["127.0.0.1", "localhost", process.env.NO_PROXY].filter(Boolean).join(",");

// Importado depois de ajustar o env.
const { default: config } = await import("../../src/database/mikro-orm.config");
const sqs = await import("../../src/messaging/infra/sqs.client");
export const { sqsClient, queueUrl, QUEUE_NAME, DLQ_NAME, EVENTS_QUEUE_NAME } = sqs;

export async function initOrm(): Promise<MikroORM> {
  const orm = await MikroORM.init({ ...config, clientUrl: TEST_DB_URL, debug: false });
  await orm.getMigrator().up();
  return orm;
}

export async function pg(): Promise<Client> {
  const c = new Client({ connectionString: TEST_DB_URL });
  await c.connect();
  return c;
}

/** TRUNCATE não dispara o trigger row-level de imutabilidade do ledger (só reset de teste). */
export async function resetDb(c: Client) {
  await c.query(`truncate outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets cascade`);
}

/** Cria as filas se não existirem (LocalStack já cria pelo init script) e esvazia. */
export async function ensureQueues() {
  const dlq = await sqsClient.send(
    new CreateQueueCommand({ QueueName: DLQ_NAME, Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" } }),
  );
  const dlqArn = (
    await sqsClient.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ["QueueArn"] }))
  ).Attributes!.QueueArn!;
  await sqsClient.send(
    new CreateQueueCommand({
      QueueName: QUEUE_NAME,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
        VisibilityTimeout: "5",
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: "5" }),
      },
    }),
  );
  await sqsClient.send(
    new CreateQueueCommand({ QueueName: EVENTS_QUEUE_NAME, Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" } }),
  );
  // Sem PurgeQueue (limite de 1 a cada 60s no SQS): os testes filtram por marcadores únicos.
}

export async function drain(queue: string, waitSeconds = 1): Promise<string[]> {
  const bodies: string[] = [];
  for (;;) {
    const res = await sqsClient.send(
      new ReceiveMessageCommand({ QueueUrl: await queueUrl(queue), MaxNumberOfMessages: 10, WaitTimeSeconds: waitSeconds, VisibilityTimeout: 60 }),
    );
    if (!res.Messages?.length) return bodies;
    for (const m of res.Messages) {
      bodies.push(m.Body ?? "");
      await sqsClient.send(new DeleteMessageCommand({ QueueUrl: await queueUrl(queue), ReceiptHandle: m.ReceiptHandle }));
    }
  }
}

// ------------------------------------------------------------------ instâncias reais da aplicação

export interface Instance {
  port: number;
  proc: Subprocess;
  url: string;
}

export async function startInstance(port: number, env: Record<string, string> = {}): Promise<Instance> {
  const proc = Bun.spawn(["bun", "run", "src/main.ts"], {
    cwd: `${import.meta.dir}/../..`,
    env: {
      ...process.env,
      PORT: String(port),
      // Passados explicitamente: o spread de process.env não carrega o NO_PROXY ajustado em runtime.
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      AWS_ENDPOINT: process.env.AWS_ENDPOINT!,
      DATABASE_URL: TEST_DB_URL,
      RUN_MIGRATIONS: "false",
      SQS_CONSUMER_ENABLED: "false",
      SQS_WAIT_SECONDS: "1",
      OUTBOX_POLL_MS: "200",
      PENDING_REFERENCE_POLL_MS: "200",
      PENDING_REFERENCE_BASE_DELAY_MS: "100",
      ...env,
    },
    stdout: process.env.TEST_APP_LOGS ? "inherit" : "ignore",
    stderr: "inherit",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/health/live`)).ok) return { port, proc, url };
    } catch {}
    await Bun.sleep(100);
  }
  proc.kill();
  throw new Error(`instância ${port} não subiu`);
}

export async function stopInstance(i: Instance, signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
  i.proc.kill(signal);
  await i.proc.exited;
}

// ------------------------------------------------------------------ chamadas HTTP

export const PLAYER = () => crypto.randomUUID();

export async function createWallet(url: string, amount: string, playerId = PLAYER(), currency = "BRL") {
  const res = await fetch(`${url}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency } }),
  });
  return { status: res.status, body: (await res.json()) as { id: string; playerId: string; balance: { amount: string } } };
}

export interface WagerBody {
  providerId?: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId?: string;
  gameId?: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export async function submit(url: string, body: WagerBody, key?: string) {
  const full = { providerId: "provider-a", roundId: "round-1", gameId: "fortune-chimp", ...body };
  const res = await fetch(`${url}/wagering/transactions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": key ?? `${full.providerId}:${full.externalTransactionId}`,
    },
    body: JSON.stringify(full),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

export const brl = (amount: string) => ({ amount, currency: "BRL" });

/** Invariante final: wallet.balance == saldo reconstruído pelo ledger, para TODAS as wallets. */
export async function assertLedgerInvariant(c: Client) {
  const { rows } = await c.query(`
    select w.id, w.balance::text as stored,
           coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text as calc
      from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
     group by w.id, w.balance
    having w.balance <> coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)`);
  return rows as { id: string; stored: string; calc: string }[];
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 15000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout esperando condição");
    await Bun.sleep(100);
  }
}
