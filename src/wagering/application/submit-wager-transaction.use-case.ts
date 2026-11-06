import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { randomUUIDv7 } from "bun";
import { DomainError, InsufficientFundsError } from "../../shared/domain/errors";
import { Money, type MoneyProps } from "../../shared/domain/money";
import { log } from "../../shared/infra/logger";
import { metrics } from "../../shared/infra/metrics";
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type EventContext,
} from "../../messaging/domain/events";
import type { IntegrationEvent } from "../../messaging/domain/integration-event";
import { enqueueOutbox } from "../../messaging/infra/outbox.writer";
import { WalletRepository } from "../../wallet/infra/wallet.repository";
import { FailureCode } from "../domain/failure-code";
import { payloadHash } from "../domain/payload-hash";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../domain/wager-transaction";
import { WagerTransactionRepository } from "../infra/wager-transaction.repository";

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

const SUBMITTABLE = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

/**
 * Caso de uso ÚNICO, usado pela API HTTP e pelo consumidor SQS.
 *
 * Fluxo (tudo numa transação SQL):
 *  1. lock pessimista da wallet (SELECT ... FOR UPDATE);
 *  2. INSERT da transação com ON CONFLICT → detecta replay/conflito de forma persistente;
 *  3. aplica a regra de negócio no domínio (Wallet.debit/credit);
 *  4. grava saldo, ledger, resultado e eventos na outbox;
 *  5. commit. Só depois disso a resposta sai / o ack acontece.
 */
@Injectable()
export class SubmitWagerTransactionUseCase {
  private readonly wallets = new WalletRepository();
  private readonly transactions = new WagerTransactionRepository();

  constructor(private readonly em: EntityManager) {}

  async execute(input: SubmitWagerInput): Promise<SubmitWagerResult> {
    if (!SUBMITTABLE.has(input.kind)) {
      throw new DomainError("INVALID_KIND", `kind inválido: ${input.kind}`); // OPENING é interno
    }
    const money = Money.from(input.money); // valida antes de abrir transação
    const hash = payloadHash({ ...input, money: money.toJSON() });
    const now = new Date();
    const ctx: EventContext = { correlationId: input.correlationId, now };

    return this.em.fork().transactional(async (em) => {
      const wallet = await this.wallets.lockById(em, input.walletId);
      if (!wallet) throw new WalletNotFoundError();

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
      if (!inserted) return this.replay(em, input, hash);

      const events: IntegrationEvent<unknown>[] = [];
      const reject = (code: FailureCode) => {
        tx.reject(code);
        events.push(WagerTransactionRejected.from(tx, ctx));
      };

      if (wallet.playerId !== input.playerId) {
        reject(FailureCode.WalletOwnershipMismatch);
      } else if (money.currency !== wallet.currency) {
        reject(FailureCode.CurrencyMismatch);
      } else if (tx.requiresReference()) {
        // TODO(candidato): resolver a referência por (providerId, referenceExternalTransactionId),
        // validar provider/player/wallet/moeda/rodada, kind permitido, valor igual, reversão única,
        // e saldo não negativo (REVERSAL_WOULD_OVERDRAW). Se não existir: markPendingReference()
        // + evento WagerTransactionPendingReference + next_attempt_at para o worker.
        throw new DomainError("NOT_IMPLEMENTED", "REFUND/ROLLBACK ainda não implementados");
      } else if (tx.affectsBalance()) {
        const versionBefore = wallet.version;
        try {
          const entry =
            tx.kind === WagerTransactionKind.Bet ? wallet.debit(money, tx.id, now) : wallet.credit(money, tx.id, now);
          await this.wallets.updateBalance(em, wallet, versionBefore);
          await this.wallets.insertLedgerEntry(em, entry);
          tx.markProcessed(undefined, now);
          events.push(WagerTransactionProcessed.from(tx, ctx), WalletBalanceChanged.from(wallet, entry, ctx));
        } catch (err) {
          if (!(err instanceof InsufficientFundsError)) throw err;
          reject(FailureCode.InsufficientFunds);
        }
      } else {
        // LOSS: registra o resultado sem mover saldo e sem ledger.
        tx.markProcessed(undefined, now);
        events.push(WagerTransactionProcessed.from(tx, ctx));
      }

      await this.transactions.saveOutcome(em, tx, wallet.balance);
      await enqueueOutbox(em, events);
      metrics.inc("wager_transactions_total", { status: tx.status, kind: tx.kind });
      log.info("wager transaction applied", {
        correlationId: input.correlationId,
        transactionId: tx.id,
        walletId: wallet.id,
        providerId: tx.providerId,
        status: tx.status,
      });

      return {
        transactionId: tx.id,
        status: tx.status,
        balance: wallet.balance.toJSON(),
        failureCode: tx.failureCode,
        idempotentReplay: false,
      };
    });
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
    metrics.inc("duplicates_detected_total");
    return {
      transactionId: existing.id,
      status: existing.status,
      balance: { amount: Money.fromPersistence(existing.result_balance ?? "0", existing.currency).toString(), currency: existing.currency },
      failureCode: existing.failure_code ?? undefined,
      idempotentReplay: true,
    };
  }
}
