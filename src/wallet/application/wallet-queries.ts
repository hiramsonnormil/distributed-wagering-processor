import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { DomainError } from "../../shared/domain/errors";
import { Money, type MoneyProps } from "../../shared/domain/money";
import { log } from "../../shared/infra/logger";
import { metrics } from "../../shared/infra/metrics";

export class InvalidCursorError extends DomainError {
  constructor() {
    super("INVALID_CURSOR", "Cursor inválido");
  }
}

interface LedgerRow {
  id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date | string;
  cursor_ts: string;
}

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Cursor opaco = base64url("<created_at exato do Postgres>|<id>"). Ordem estável por (created_at, id):
 * id (UUIDv7) desempata lançamentos no mesmo instante, e novos lançamentos não deslocam páginas já lidas.
 */
const encodeCursor = (ts: string, id: string) => Buffer.from(`${ts}|${id}`).toString("base64url");
function decodeCursor(cursor: string): { ts: string; id: string } {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const i = raw.lastIndexOf("|");
  const ts = raw.slice(0, i);
  const id = raw.slice(i + 1);
  // ts vem do próprio Postgres (created_at::text, microssegundos preservados); valida o formato.
  if (i <= 0 || !/^[0-9a-f-]{36}$/i.test(id) || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:?\d{2})?$/.test(ts)) {
    throw new InvalidCursorError();
  }
  return { ts, id };
}

@Injectable()
export class WalletQueries {
  constructor(private readonly em: EntityManager) {}

  async ledger(walletId: string, cursor: string | undefined, limitParam: string | undefined) {
    const limit = limitParam === undefined ? 50 : Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new DomainError("INVALID_LIMIT", "limit deve ser 1..200");
    const em = this.em.fork();
    await this.assertWallet(em, walletId);

    const params: unknown[] = [walletId];
    let where = `wallet_id = ?`;
    if (cursor) {
      const c = decodeCursor(cursor);
      where += ` and (created_at, id) > (?::timestamptz, ?::uuid)`;
      params.push(c.ts, c.id);
    }
    params.push(limit + 1);
    const rows = await em.execute<LedgerRow[]>(
      `select *, created_at::text as cursor_ts from wallet_ledger_entries
        where ${where} order by created_at, id limit ?`,
      params,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        transactionId: r.transaction_id,
        direction: r.direction,
        money: Money.fromPersistence(r.amount, r.currency).toJSON(),
        balanceBefore: Money.fromPersistence(r.balance_before, r.currency).toJSON(),
        balanceAfter: Money.fromPersistence(r.balance_after, r.currency).toJSON(),
        createdAt: new Date(r.created_at).toISOString(),
      })),
      nextCursor: rows.length > limit && last ? encodeCursor(last.cursor_ts, last.id) : null,
    };
  }

  /**
   * Compara o saldo materializado com o saldo reconstruído pelo ledger (Σ CREDIT − Σ DEBIT),
   * numa única query (mesmo snapshot). Divergência NÃO é corrigida: log de erro + métrica + flag.
   */
  async reconcile(walletId: string): Promise<ReconciliationReport> {
    const em = this.em.fork();
    const rows = await em.execute<{ balance: string; currency: string; calculated: string; entries: string }[]>(
      `select w.balance, w.currency,
              coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0) as calculated,
              count(l.id) as entries
         from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    );
    const row = rows[0];
    if (!row) throw new DomainError("WALLET_NOT_FOUND", "Wallet não encontrada");
    const stored = Money.fromPersistence(row.balance, row.currency);
    const calculated = Money.fromPersistence(row.calculated, row.currency);
    const difference = stored.subtract(calculated);
    const consistent = difference.isZero();
    metrics.inc("reconciliations_total", { consistent: String(consistent) });
    if (!consistent) {
      metrics.inc("reconciliation_mismatches_total");
      log.error("wallet reconciliation mismatch", { walletId, difference: difference.toString() });
    }
    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: Number(row.entries),
    };
  }

  private async assertWallet(em: EntityManager, walletId: string) {
    const rows = await em.execute<{ id: string }[]>(`select id from wallets where id = ?`, [walletId]);
    if (!rows[0]) throw new DomainError("WALLET_NOT_FOUND", "Wallet não encontrada");
  }
}
