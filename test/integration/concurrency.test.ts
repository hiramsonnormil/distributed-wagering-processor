import "./setup-env";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { Client } from "pg";
import {
  assertLedgerInvariant,
  brl,
  createWallet,
  ensureQueues,
  initOrm,
  pg,
  resetDb,
  startInstance,
  stopInstance,
  submit,
  waitFor,
  type Instance,
} from "./helpers";

/**
 * Paralelismo REAL: 3 processos da aplicação, mesmo PostgreSQL, requisições disparadas em paralelo
 * e distribuídas entre as instâncias (round-robin).
 */
describe("concorrência com 3 instâncias", () => {
  let orm: MikroORM;
  let c: Client;
  let instances: Instance[] = [];
  const ports = [3301, 3302, 3303];
  const at = (i: number) => instances[i % instances.length]!.url;

  beforeAll(async () => {
    orm = await initOrm();
    c = await pg();
    await resetDb(c);
    await ensureQueues();
    instances = await Promise.all(ports.map((p) => startInstance(p)));
  });

  afterAll(async () => {
    await Promise.all(instances.map((i) => stopInstance(i)));
    await c.end();
    await orm.close();
  });

  it("cenário obrigatório: saldo 100, duas apostas de 80 simultâneas", async () => {
    const { body: w } = await createWallet(at(0), "100.00");
    const results = await Promise.all(
      [0, 1].map((i) =>
        submit(at(i), { externalTransactionId: `bet-80-${i}-${w.id}`, playerId: w.playerId, walletId: w.id, kind: "BET", money: brl("80.00") }),
      ),
    );
    const statuses = results.map((r) => r.body.status).sort();
    expect(statuses).toEqual(["PROCESSED", "REJECTED"]);
    expect(results.find((r) => r.body.status === "REJECTED")!.body.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);

    const { rows } = await c.query(`select balance::text from wallets where id = $1`, [w.id]);
    expect(rows[0].balance).toBe("20.00");
    const debits = await c.query(`select count(*)::int as n from wallet_ledger_entries where wallet_id = $1 and direction = 'DEBIT'`, [w.id]);
    expect(debits.rows[0].n).toBe(1);
  });

  it("a mesma aposta 50x em paralelo → um único débito, 1×201 e 49×200", async () => {
    const { body: w } = await createWallet(at(0), "1000.00");
    const body = { externalTransactionId: `same-${w.id}`, playerId: w.playerId, walletId: w.id, kind: "BET", money: brl("25.00") };
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(at(i), body)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200 && r.body.idempotentReplay === true)).toHaveLength(49);
    // Todas as respostas enxergam o MESMO resultado original (saldo observado incluso).
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(new Set(results.map((r) => r.body.balance.amount))).toEqual(new Set(["975.00"]));
    const { rows } = await c.query(`select count(*)::int as n from wallet_ledger_entries where wallet_id = $1 and direction = 'DEBIT'`, [w.id]);
    expect(rows[0].n).toBe(1);
  });

  it("hot wallet: 120 apostas de 1.00 com saldo 50 → exatamente 50 aplicadas", async () => {
    const { body: w } = await createWallet(at(0), "50.00");
    const results = await Promise.all(
      Array.from({ length: 120 }, (_, i) =>
        submit(at(i), { externalTransactionId: `hot-${i}-${w.id}`, playerId: w.playerId, walletId: w.id, kind: "BET", money: brl("1.00") }),
      ),
    );
    expect(results.filter((r) => r.body.status === "PROCESSED")).toHaveLength(50);
    expect(results.filter((r) => r.body.failureCode === "INSUFFICIENT_FUNDS")).toHaveLength(70);
    const { rows } = await c.query(`select balance::text, version from wallets where id = $1`, [w.id]);
    expect(rows[0].balance).toBe("0.00");
    expect(rows[0].version).toBe(51); // 1 (abertura) + 50 débitos: só incrementa quando o saldo muda
  });

  it("wallets distintas processadas em paralelo", async () => {
    const wallets = await Promise.all(Array.from({ length: 15 }, (_, i) => createWallet(at(i), "100.00")));
    const ops = wallets.flatMap(({ body: w }) =>
      Array.from({ length: 8 }, (_, j) =>
        submit(at(j), { externalTransactionId: `par-${j}-${w.id}`, playerId: w.playerId, walletId: w.id, kind: j % 2 ? "WIN" : "BET", money: brl("10.00") }),
      ),
    );
    const results = await Promise.all(ops);
    expect(results.every((r) => r.body.status === "PROCESSED")).toBe(true);
    const { rows } = await c.query(`select balance::text from wallets where id = any($1)`, [wallets.map((w) => w.body.id)]);
    expect(new Set(rows.map((r) => r.balance))).toEqual(new Set(["100.00"]));
  });

  it("mesma key com payload diferente → 409 e não replay", async () => {
    const { body: w } = await createWallet(at(0), "100.00");
    const first = await submit(at(0), { externalTransactionId: `conf-${w.id}`, playerId: w.playerId, walletId: w.id, kind: "BET", money: brl("10.00") });
    const second = await submit(at(1), { externalTransactionId: `conf-${w.id}`, playerId: w.playerId, walletId: w.id, kind: "BET", money: brl("11.00") });
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("REFUND e ROLLBACK: reversão única, valor igual, overdraw com código próprio", async () => {
    const { body: w } = await createWallet(at(0), "100.00");
    const base = { playerId: w.playerId, walletId: w.id };
    await submit(at(0), { ...base, externalTransactionId: `b1-${w.id}`, kind: "BET", money: brl("30.00") });

    const wrongAmount = await submit(at(1), { ...base, externalTransactionId: `rf0-${w.id}`, kind: "REFUND", money: brl("10.00"), referenceExternalTransactionId: `b1-${w.id}` });
    expect(wrongAmount.body.failureCode).toBe("AMOUNT_MISMATCH");

    const refund = await submit(at(1), { ...base, externalTransactionId: `rf1-${w.id}`, kind: "REFUND", money: brl("30.00"), referenceExternalTransactionId: `b1-${w.id}` });
    expect(refund.status).toBe(201);
    expect(refund.body.balance.amount).toBe("100.00");

    const again = await submit(at(2), { ...base, externalTransactionId: `rb1-${w.id}`, kind: "ROLLBACK", money: brl("30.00"), referenceExternalTransactionId: `b1-${w.id}` });
    expect(again.status).toBe(422);
    expect(again.body.failureCode).toBe("REFERENCE_ALREADY_REVERSED");

    // WIN de 50, gasta 80, ROLLBACK do WIN deixaria saldo negativo.
    await submit(at(0), { ...base, externalTransactionId: `w1-${w.id}`, kind: "WIN", money: brl("50.00") });
    await submit(at(0), { ...base, externalTransactionId: `b2-${w.id}`, kind: "BET", money: brl("130.00") });
    const overdraw = await submit(at(1), { ...base, externalTransactionId: `rb2-${w.id}`, kind: "ROLLBACK", money: brl("50.00"), referenceExternalTransactionId: `w1-${w.id}` });
    expect(overdraw.body.failureCode).toBe("REVERSAL_WOULD_OVERDRAW");
    const { rows } = await c.query(`select balance::text from wallets where id = $1`, [w.id]);
    expect(rows[0].balance).toBe("20.00");
  });

  it("LOSS registra resultado sem mover saldo e sem ledger", async () => {
    const { body: w } = await createWallet(at(0), "10.00");
    const loss = await submit(at(0), { externalTransactionId: `loss-${w.id}`, playerId: w.playerId, walletId: w.id, kind: "LOSS", money: brl("5.00") });
    expect(loss.body.status).toBe("PROCESSED");
    expect(loss.body.balance.amount).toBe("10.00");
    const { rows } = await c.query(`select count(*)::int as n from wallet_ledger_entries where wallet_id = $1`, [w.id]);
    expect(rows[0].n).toBe(1); // só o OPENING
  });

  it("ROLLBACK entregue ANTES da BET → PENDING_REFERENCE (202) e depois PROCESSED pelo worker", async () => {
    const { body: w } = await createWallet(at(0), "100.00");
    const base = { playerId: w.playerId, walletId: w.id };
    const early = await submit(at(1), { ...base, externalTransactionId: `rb-early-${w.id}`, kind: "ROLLBACK", money: brl("40.00"), referenceExternalTransactionId: `bet-late-${w.id}` });
    expect(early.status).toBe(202);
    expect(early.body.status).toBe("PENDING_REFERENCE");

    const bet = await submit(at(2), { ...base, externalTransactionId: `bet-late-${w.id}`, kind: "BET", money: brl("40.00") });
    expect(bet.body.balance.amount).toBe("60.00");

    const done = await waitFor(async () => {
      const r = await fetch(`${at(0)}/providers/provider-a/wagering/transactions/rb-early-${w.id}`).then((x) => x.json() as Promise<any>);
      return r.status === "PROCESSED" ? r : undefined;
    });
    expect(done.status).toBe("PROCESSED");
    const { rows } = await c.query(`select balance::text from wallets where id = $1`, [w.id]);
    expect(rows[0].balance).toBe("100.00");
  });

  it("ledger paginado por cursor estável e reconciliação consistente", async () => {
    const { body: w } = await createWallet(at(0), "100.00");
    for (let i = 0; i < 7; i++) {
      await submit(at(i), { externalTransactionId: `pg-${i}-${w.id}`, playerId: w.playerId, walletId: w.id, kind: "BET", money: brl("1.00") });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: any = await fetch(`${at(1)}/wallets/${w.id}/ledger?limit=3${cursor ? `&cursor=${cursor}` : ""}`).then((r) => r.json());
      seen.push(...page.items.map((i: { id: string }) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);

    const rec: any = await fetch(`${at(2)}/wallets/${w.id}/reconciliation`, { method: "POST" }).then((r) => r.json());
    expect(rec).toMatchObject({ consistent: true, checkedEntries: 8, storedBalance: brl("93.00"), difference: brl("0.00") });
    expect((await fetch(`${at(0)}/wallets/${w.id}/ledger?cursor=lixo`)).status).toBe(400);
  });

  it("reinício brusco (SIGKILL) no meio da carga → consistência final comprovada", async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, (_, i) => createWallet(at(i), "500.00")));
    const load = wallets.flatMap(({ body: w }) =>
      Array.from({ length: 30 }, (_, j) =>
        submit(at(j), { externalTransactionId: `crash-${j}-${w.id}`, playerId: w.playerId, walletId: w.id, kind: "BET", money: brl("3.00") }).catch(() => undefined),
      ),
    );
    await Bun.sleep(150);
    await Promise.all(instances.map((i) => stopInstance(i, "SIGKILL")));
    await Promise.allSettled(load);
    instances = await Promise.all(ports.map((p) => startInstance(p)));

    // Provedor reenvia tudo (at-least-once): nada duplica.
    const retry = await Promise.all(
      wallets.flatMap(({ body: w }) =>
        Array.from({ length: 30 }, (_, j) =>
          submit(at(j + 1), { externalTransactionId: `crash-${j}-${w.id}`, playerId: w.playerId, walletId: w.id, kind: "BET", money: brl("3.00") }),
        ),
      ),
    );
    expect(retry.every((r) => r.body.status === "PROCESSED")).toBe(true);
    const { rows } = await c.query(`select balance::text from wallets where id = any($1)`, [wallets.map((w) => w.body.id)]);
    expect(new Set(rows.map((r) => r.balance))).toEqual(new Set(["410.00"]));
    expect(await assertLedgerInvariant(c)).toEqual([]);
  });

  it("invariante final: wallet.balance == saldo reconstruído pelo ledger em TODAS as wallets", async () => {
    expect(await assertLedgerInvariant(c)).toEqual([]);
  });
});
