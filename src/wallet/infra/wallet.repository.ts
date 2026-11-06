import type { EntityManager } from "@mikro-orm/postgresql";
import { Money } from "../../shared/domain/money";
import type { WalletLedgerEntry } from "../domain/ledger-entry";
import { Wallet } from "../domain/wallet";

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const toDomain = (r: WalletRow) =>
  Wallet.rehydrate({
    id: r.id,
    playerId: r.player_id,
    currency: r.currency,
    balance: Money.fromPersistence(r.balance, r.currency),
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

export class WalletRepository {
  async findById(em: EntityManager, id: string): Promise<Wallet | null> {
    const rows = await em.execute<WalletRow[]>(`select * from wallets where id = ?`, [id]);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  /**
   * Lock pessimista por wallet (unidade de concorrência). Só a linha desta wallet é bloqueada,
   * então wallets diferentes seguem em paralelo. Deve ser chamado dentro de em.transactional().
   */
  async lockById(em: EntityManager, id: string): Promise<Wallet | null> {
    const rows = await em.execute<WalletRow[]>(`select * from wallets where id = ? for update`, [id]);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async insert(em: EntityManager, w: Wallet): Promise<void> {
    await em.execute(
      `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [w.id, w.playerId, w.currency, w.balance.toString(), w.version, w.createdAt, w.updatedAt],
    );
  }

  /** Update condicionado à versão lida: proteção extra contra lost update. */
  async updateBalance(em: EntityManager, w: Wallet, expectedVersion: number): Promise<void> {
    const res = await em.execute(
      `update wallets set balance = ?, version = ?, updated_at = ? where id = ? and version = ?`,
      [w.balance.toString(), w.version, w.updatedAt, w.id, expectedVersion],
      "run",
    );
    if ((res as { affectedRows?: number }).affectedRows !== 1) {
      throw new Error(`Conflito de versão na wallet ${w.id}`);
    }
  }

  async insertLedgerEntry(em: EntityManager, e: WalletLedgerEntry): Promise<void> {
    await em.execute(
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.id, e.walletId, e.transactionId, e.direction, e.money.toString(), e.money.currency,
       e.balanceBefore.toString(), e.balanceAfter.toString(), e.createdAt],
    );
  }
}
