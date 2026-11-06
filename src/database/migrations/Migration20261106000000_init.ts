import { Migration } from "@mikro-orm/migrations";

/**
 * Schema inicial. As invariantes ficam NO BANCO (seção 5 do desafio):
 * unicidade, imutabilidade do ledger e não-negatividade do saldo.
 */
export class Migration20261106000000_init extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null,
        balance numeric(20,2) not null check (balance >= 0),
        version integer not null check (version >= 1),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint wallets_player_currency_uq unique (player_id, currency)
      );`);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash char(64) not null,
        wallet_id uuid not null references wallets(id),
        player_id uuid not null,
        round_id text not null,
        game_id text not null,
        kind text not null check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount numeric(20,2) not null check (amount > 0),
        currency char(3) not null,
        reference_external_transaction_id text,
        reference_transaction_id uuid references wager_transactions(id),
        status text not null check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code text,
        result_balance numeric(20,2),
        attempts integer not null default 0,
        next_attempt_at timestamptz,
        created_at timestamptz not null default now(),
        processed_at timestamptz,
        constraint wager_tx_idempotency_uq unique (idempotency_key),
        constraint wager_tx_provider_external_uq unique (provider_id, external_transaction_id),
        constraint wager_tx_reference_required_ck check (
          kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null
        ),
        constraint wager_tx_failure_code_ck check (
          (status in ('REJECTED','FAILED')) = (failure_code is not null)
        )
      );`);

    // Uma referência só pode ser revertida uma vez por tipo de operação.
    this.addSql(`
      create unique index wager_tx_single_reversal_uq
        on wager_transactions (reference_transaction_id, kind)
        where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED';`);
    this.addSql(`create index wager_tx_pending_ref_idx on wager_transactions (next_attempt_at) where status = 'PENDING_REFERENCE';`);
    this.addSql(`create index wager_tx_reference_lookup_idx on wager_transactions (provider_id, reference_external_transaction_id);`);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null references wallets(id),
        transaction_id uuid not null references wager_transactions(id),
        direction text not null check (direction in ('DEBIT','CREDIT')),
        amount numeric(20,2) not null check (amount > 0),
        currency char(3) not null,
        balance_before numeric(20,2) not null check (balance_before >= 0),
        balance_after numeric(20,2) not null check (balance_after >= 0),
        created_at timestamptz not null default now(),
        constraint ledger_one_entry_per_tx_wallet_uq unique (transaction_id, wallet_id),
        constraint ledger_balanced_ck check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT'  and balance_after = balance_before - amount)
        )
      );`);
    this.addSql(`create index ledger_wallet_cursor_idx on wallet_ledger_entries (wallet_id, created_at, id);`);

    // Ledger imutável: bloqueia UPDATE e DELETE no nível do banco.
    this.addSql(`
      create or replace function forbid_ledger_mutation() returns trigger as $$
      begin
        raise exception 'wallet_ledger_entries is append-only';
      end;
      $$ language plpgsql;`);
    this.addSql(`
      create trigger wallet_ledger_entries_immutable
        before update or delete on wallet_ledger_entries
        for each row execute function forbid_ledger_mutation();`);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash char(64) not null,
        received_at timestamptz not null default now(),
        processed_at timestamptz,
        primary key (consumer_name, message_id)
      );`);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz not null default now(),
        published_at timestamptz
      );`);
    this.addSql(`create index outbox_pending_idx on outbox_messages (next_attempt_at) where published_at is null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists outbox_messages;`);
    this.addSql(`drop table if exists inbox_messages;`);
    this.addSql(`drop trigger if exists wallet_ledger_entries_immutable on wallet_ledger_entries;`);
    this.addSql(`drop function if exists forbid_ledger_mutation();`);
    this.addSql(`drop table if exists wallet_ledger_entries;`);
    this.addSql(`drop table if exists wager_transactions;`);
    this.addSql(`drop table if exists wallets;`);
  }
}
