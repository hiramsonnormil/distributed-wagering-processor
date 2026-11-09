import "./setup-env";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { Client } from "pg";
import { initOrm, pg, resetDb } from "./helpers";

/** As invariantes estão NO BANCO, não só no código (seção 5.9). */
describe("migrations e constraints", () => {
  let orm: MikroORM;
  let c: Client;
  const player = crypto.randomUUID();
  const wallet = crypto.randomUUID();
  const tx = crypto.randomUUID();

  beforeAll(async () => {
    orm = await initOrm();
    c = await pg();
    await resetDb(c);
    await c.query(`insert into wallets (id, player_id, currency, balance, version) values ($1, $2, 'BRL', 100, 1)`, [wallet, player]);
    await c.query(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, status)
       values ($1, 'p', 'e1', 'p:e1', repeat('a', 64), $2, $3, 'r', 'g', 'BET', 10, 'BRL', 'PROCESSED')`,
      [tx, wallet, player],
    );
    await c.query(
      `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
       values ($1, $2, $3, 'DEBIT', 10, 'BRL', 100, 90)`,
      [crypto.randomUUID(), wallet, tx],
    );
  });

  afterAll(async () => {
    await c.end();
    await orm.close();
  });

  const fails = async (sql: string, params: unknown[] = []) => {
    let err: { code?: string; message?: string } | undefined;
    await c.query("savepoint s");
    try {
      await c.query(sql, params);
    } catch (e) {
      err = e as { code?: string };
    }
    await c.query("rollback to savepoint s");
    return err;
  };

  it("saldo negativo é barrado por CHECK", async () => {
    await c.query("begin");
    expect((await fails(`update wallets set balance = -1 where id = $1`, [wallet]))?.code).toBe("23514");
    await c.query("rollback");
  });

  it("uma wallet por playerId + currency", async () => {
    await c.query("begin");
    const err = await fails(`insert into wallets (id, player_id, currency, balance, version) values ($1, $2, 'BRL', 0, 1)`, [
      crypto.randomUUID(), player,
    ]);
    expect(err?.code).toBe("23505");
    await c.query("rollback");
  });

  it("ledger é append-only: UPDATE e DELETE são bloqueados por trigger", async () => {
    await c.query("begin");
    expect((await fails(`update wallet_ledger_entries set amount = 1`))?.message).toContain("append-only");
    expect((await fails(`delete from wallet_ledger_entries`))?.message).toContain("append-only");
    await c.query("rollback");
  });

  it("lançamento desbalanceado é barrado", async () => {
    await c.query("begin");
    const err = await fails(
      `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
       values ($1, $2, $3, 'CREDIT', 10, 'BRL', 90, 999)`,
      [crypto.randomUUID(), wallet, tx],
    );
    expect(err?.code).toBe("23514");
    await c.query("rollback");
  });

  it("um lançamento por transação e wallet", async () => {
    await c.query("begin");
    const err = await fails(
      `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
       values ($1, $2, $3, 'DEBIT', 10, 'BRL', 90, 80)`,
      [crypto.randomUUID(), wallet, tx],
    );
    expect(err?.code).toBe("23505");
    await c.query("rollback");
  });

  it("idempotency key única e REFUND sem referência barrado", async () => {
    await c.query("begin");
    const dup = await fails(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, status)
       values ($1, 'p', 'e2', 'p:e1', repeat('a', 64), $2, $3, 'r', 'g', 'BET', 10, 'BRL', 'PENDING')`,
      [crypto.randomUUID(), wallet, player],
    );
    expect(dup?.code).toBe("23505");
    const noRef = await fails(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, status)
       values ($1, 'p', 'e3', 'p:e3', repeat('a', 64), $2, $3, 'r', 'g', 'REFUND', 10, 'BRL', 'PENDING')`,
      [crypto.randomUUID(), wallet, player],
    );
    expect(noRef?.code).toBe("23514");
    await c.query("rollback");
  });

  it("uma referência aceita uma única reversão PROCESSED", async () => {
    await c.query("begin");
    const insertReversal = (ext: string, kind: string) =>
      c.query(
        `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
           round_id, game_id, kind, amount, currency, status, reference_external_transaction_id, reference_transaction_id)
         values ($1, 'p', $2, $3, repeat('a', 64), $4, $5, 'r', 'g', $6, 10, 'BRL', 'PROCESSED', 'e1', $7)`,
        [crypto.randomUUID(), ext, `p:${ext}`, wallet, player, kind, tx],
      );
    await insertReversal("r1", "REFUND");
    await c.query("savepoint s");
    let code: string | undefined;
    try {
      await insertReversal("r2", "ROLLBACK");
    } catch (e) {
      code = (e as { code: string }).code;
    }
    expect(code).toBe("23505");
    await c.query("rollback");
  });
});
