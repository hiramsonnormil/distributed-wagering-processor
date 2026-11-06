import type { EntityManager } from "@mikro-orm/postgresql";
import { Money } from "../../shared/domain/money";
import type { FailureCode } from "../domain/failure-code";
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../domain/wager-transaction";

export interface WagerTransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: WagerTransactionStatus;
  failure_code: FailureCode | null;
  result_balance: string | null;
  created_at: Date;
  processed_at: Date | null;
}

export const rowToTransaction = (r: WagerTransactionRow) =>
  WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.provider_id,
    externalTransactionId: r.external_transaction_id,
    idempotencyKey: r.idempotency_key,
    payloadHash: r.payload_hash,
    walletId: r.wallet_id,
    playerId: r.player_id,
    roundId: r.round_id,
    gameId: r.game_id,
    kind: r.kind,
    money: Money.fromPersistence(r.amount, r.currency),
    referenceExternalTransactionId: r.reference_external_transaction_id ?? undefined,
    referenceTransactionId: r.reference_transaction_id ?? undefined,
    status: r.status,
    failureCode: r.failure_code ?? undefined,
    createdAt: r.created_at,
    processedAt: r.processed_at ?? undefined,
  });

export class WagerTransactionRepository {
  /**
   * Insere em PENDING. Se a idempotency key (ou provider+externalId) já existir, não insere
   * e devolve false. Duas inserções concorrentes com a mesma key: o índice único faz a segunda
   * esperar o commit da primeira e então cair no ON CONFLICT.
   */
  async tryInsert(em: EntityManager, tx: WagerTransaction): Promise<boolean> {
    const rows = await em.execute<{ id: string }[]>(
      `insert into wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
          round_id, game_id, kind, amount, currency, reference_external_transaction_id, status, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict do nothing
       returning id`,
      [tx.id, tx.providerId, tx.externalTransactionId, tx.idempotencyKey, tx.payloadHash, tx.walletId,
       tx.playerId, tx.roundId, tx.gameId, tx.kind, tx.money.toString(), tx.money.currency,
       tx.referenceExternalTransactionId ?? null, tx.status, tx.createdAt],
    );
    return rows.length === 1;
  }

  async findExisting(
    em: EntityManager,
    idempotencyKey: string,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionRow | null> {
    const rows = await em.execute<WagerTransactionRow[]>(
      `select * from wager_transactions
        where idempotency_key = ? or (provider_id = ? and external_transaction_id = ?)
        limit 1`,
      [idempotencyKey, providerId, externalTransactionId],
    );
    return rows[0] ?? null;
  }

  async findById(em: EntityManager, id: string): Promise<WagerTransactionRow | null> {
    const rows = await em.execute<WagerTransactionRow[]>(`select * from wager_transactions where id = ?`, [id]);
    return rows[0] ?? null;
  }

  async findByExternal(em: EntityManager, providerId: string, externalId: string): Promise<WagerTransactionRow | null> {
    const rows = await em.execute<WagerTransactionRow[]>(
      `select * from wager_transactions where provider_id = ? and external_transaction_id = ?`,
      [providerId, externalId],
    );
    return rows[0] ?? null;
  }

  /** Grava o resultado final, incluindo o saldo observado (usado no replay idempotente). */
  async saveOutcome(em: EntityManager, tx: WagerTransaction, resultBalance: Money): Promise<void> {
    await em.execute(
      `update wager_transactions
          set status = ?, failure_code = ?, reference_transaction_id = ?, processed_at = ?, result_balance = ?
        where id = ?`,
      [tx.status, tx.failureCode ?? null, tx.referenceTransactionId ?? null, tx.processedAt ?? null,
       resultBalance.toString(), tx.id],
    );
  }
}
