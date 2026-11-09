import { Migration } from "@mikro-orm/migrations";

/**
 * Endurece a regra "uma referência só é revertida uma vez": em vez de (referência, kind),
 * a referência aceita UMA reversão PROCESSED no total (REFUND ou ROLLBACK). Sem isso uma BET
 * poderia receber REFUND e ROLLBACK e ser creditada duas vezes. Ver ARCHITECTURE.md.
 */
export class Migration20261109000000_single_reversal extends Migration {
  override async up(): Promise<void> {
    this.addSql(`drop index if exists wager_tx_single_reversal_uq;`);
    this.addSql(`
      create unique index wager_tx_single_reversal_uq
        on wager_transactions (reference_transaction_id)
        where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED';`);
    this.addSql(`create index if not exists outbox_occurred_pending_idx on outbox_messages (occurred_at) where published_at is null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists outbox_occurred_pending_idx;`);
    this.addSql(`drop index if exists wager_tx_single_reversal_uq;`);
    this.addSql(`
      create unique index wager_tx_single_reversal_uq
        on wager_transactions (reference_transaction_id, kind)
        where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED';`);
  }
}
