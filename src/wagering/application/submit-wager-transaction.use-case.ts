import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { randomUUIDv7 } from "bun";
import { DomainError } from "../../shared/domain/errors";
import { Money, type MoneyProps } from "../../shared/domain/money";
import { log } from "../../shared/infra/logger";
import { metrics } from "../../shared/infra/metrics";
import type { EventContext } from "../../messaging/domain/events";
import type { IntegrationEvent } from "../../messaging/domain/integration-event";
import { InboxRepository } from "../../messaging/infra/inbox.repository";
import { enqueueOutbox } from "../../messaging/infra/outbox.writer";
import { WalletRepository } from "../../wallet/infra/wallet.repository";
import type { FailureCode } from "../domain/failure-code";
import { payloadHash } from "../domain/payload-hash";
import { PENDING_REFERENCE_POLICY } from "../domain/reference-policy";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../domain/wager-transaction";
import { WagerTransactionRepository } from "../infra/wager-transaction.repository";
import { WagerProcessor } from "./wager-processor";

export interface SubmitWagerInput {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
}

/** Quando a entrada vem da fila: registro de inbox na MESMA transação. */
export interface InboxContext {
  consumerName: string;
  messageId: string;
}

export interface SubmitWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export class IdempotencyConflictError extends DomainError {
  constructor() {
    super("IDEMPOTENCY_CONFLICT", "Mesma idempotency key com payload diferente");
  }
}
export class WalletNotFoundError extends DomainError {
  constructor() {
    super("WALLET_NOT_FOUND", "Wallet não encontrada");
  }
}
export class InvalidPayloadError extends DomainError {
  constructor(message: string) {
    super("INVALID_PAYLOAD", message);
  }
}

const SUBMITTABLE = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const REQUIRED_STRINGS = ["providerId", "externalTransactionId", "playerId", "walletId", "roundId", "gameId"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Caso de uso ÚNICO, usado pela API HTTP e pelo consumidor SQS.
 *
 * Fluxo (tudo numa transação SQL):
 *  1. lock pessimista da wallet (SELECT ... FOR UPDATE) — unidade de concorrência;
 *  2. (SQS) INSERT na inbox (consumer_name, message_id) ON CONFLICT → redelivery vira replay;
 *  3. INSERT da transação com ON CONFLICT → detecta replay/conflito de forma persistente;
 *  4. WagerProcessor aplica a regra de negócio (saldo, ledger) ou deixa em PENDING_REFERENCE;
 *  5. grava resultado + eventos na outbox;
 *  6. commit. Só depois disso a resposta sai / o ack acontece.
 */
@Injectable()
export class SubmitWagerTransactionUseCase {
  private readonly wallets = new WalletRepository();
  private readonly transactions = new WagerTransactionRepository();
  private readonly inbox = new InboxRepository();
  private readonly processor = new WagerProcessor();

  constructor(private readonly em: EntityManager) {}

  async execute(input: SubmitWagerInput, inbox?: InboxContext): Promise<SubmitWagerResult> {
    validateShape(input);
    if (!SUBMITTABLE.has(input.kind)) {
      throw new DomainError("INVALID_KIND", `kind inválido: ${input.kind}`); // OPENING é interno
    }
    const money = Money.from(input.money); // valida antes de abrir transação
    const hash = payloadHash({ ...input, money: money.toJSON() });
    const started = performance.now();

    const result = await this.em.fork().transactional(async (em) => {
      await em.execute(`set local lock_timeout = '${Number(process.env.LOCK_TIMEOUT_MS ?? 5000)}ms'`);
      const now = new Date();
      const ctx: EventContext = { correlationId: input.correlationId, causationId: inbox?.messageId, now };

      const lockStart = performance.now();
      const wallet = await this.wallets.lockById(em, input.walletId);
      metrics.observe("wallet_lock_wait_ms", performance.now() - lockStart);
      if (!wallet) throw new WalletNotFoundError();

      if (inbox) {
        const fresh = await this.inbox.tryReceive(em, inbox.consumerName, inbox.messageId, hash, now);
        if (!fresh) {
          // Redelivery: o efeito já foi commitado por outra entrega da mesma mensagem.
          metrics.inc("duplicates_detected_total", { source: "inbox" });
          return this.replay(em, input, hash);
        }
      }

      const tx = WagerTransaction.create({
        id: randomUUIDv7(),
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: hash,
        walletId: input.walletId,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: input.kind as WagerTransactionKind,
        money,
        referenceExternalTransactionId: input.referenceExternalTransactionId,
        createdAt: now,
      });

      const inserted = await this.transactions.tryInsert(em, tx);
      if (!inserted) {
        const replay = await this.replay(em, input, hash);
        if (inbox) await this.inbox.markProcessed(em, inbox.consumerName, inbox.messageId, now);
        return replay;
      }

      const events: IntegrationEvent<unknown>[] = [];
      const outcome = await this.processor.process(em, tx, wallet, ctx, events);

      if (outcome === "WAITING_REFERENCE") {
        // Referência ainda não chegou: persiste e agenda o worker (seção 7.1).
        tx.markPendingReference();
        events.push(WagerProcessor.pendingEvent(tx, ctx));
        await this.transactions.schedulePendingReference(em, tx.id, 0, PENDING_REFERENCE_POLICY.nextAttemptAt(0, now));
      }

      await this.transactions.saveOutcome(em, tx, wallet.balance);
      if (tx.status === WagerTransactionStatus.Processed) {
        await this.transactions.wakeDependents(em, tx.providerId, tx.externalTransactionId);
      }
      await enqueueOutbox(em, events);
      if (inbox) await this.inbox.markProcessed(em, inbox.consumerName, inbox.messageId, now);

      metrics.inc("wager_transactions_total", { status: tx.status, kind: tx.kind });
      log.info("wager transaction applied", {
        correlationId: input.correlationId,
        messageId: inbox?.messageId,
        transactionId: tx.id,
        walletId: wallet.id,
        providerId: tx.providerId,
        kind: tx.kind,
        status: tx.status,
        failureCode: tx.failureCode,
      });

      return {
        transactionId: tx.id,
        status: tx.status,
        balance: wallet.balance.toJSON(),
        failureCode: tx.failureCode,
        idempotentReplay: false,
      } satisfies SubmitWagerResult;
    });

    metrics.observe("wager_processing_ms", performance.now() - started);
    return result;
  }

  /** Mesma key + mesmo payload → resultado original. Payload diferente → conflito. */
  private async replay(em: EntityManager, input: SubmitWagerInput, hash: string): Promise<SubmitWagerResult> {
    const existing = await this.transactions.findExisting(
      em, input.idempotencyKey, input.providerId, input.externalTransactionId,
    );
    if (!existing || existing.payload_hash !== hash || existing.idempotency_key !== input.idempotencyKey) {
      metrics.inc("idempotency_conflicts_total");
      throw new IdempotencyConflictError();
    }
    metrics.inc("duplicates_detected_total", { source: "idempotency" });
    return {
      transactionId: existing.id,
      status: existing.status,
      // Saldo observado no momento em que a transação foi aplicada (regra 7.7).
      balance: Money.fromPersistence(existing.result_balance ?? "0", existing.currency).toJSON(),
      failureCode: existing.failure_code ?? undefined,
      idempotentReplay: true,
    };
  }
}

function validateShape(input: SubmitWagerInput): void {
  for (const field of REQUIRED_STRINGS) {
    const v = (input as unknown as Record<string, unknown>)[field];
    if (typeof v !== "string" || v.trim() === "" || v.length > 200) {
      throw new InvalidPayloadError(`Campo obrigatório inválido: ${field}`);
    }
  }
  if (!UUID.test(input.walletId)) throw new InvalidPayloadError("walletId deve ser UUID");
  if (!UUID.test(input.playerId)) throw new InvalidPayloadError("playerId deve ser UUID");
  if (input.referenceExternalTransactionId !== undefined && typeof input.referenceExternalTransactionId !== "string") {
    throw new InvalidPayloadError("referenceExternalTransactionId deve ser string");
  }
  if (!input.money || typeof input.money !== "object") throw new InvalidPayloadError("money é obrigatório");
}
