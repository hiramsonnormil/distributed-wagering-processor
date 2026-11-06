import { describe, expect, it } from "bun:test";
import { DomainError, InvalidTransactionStateError } from "../../src/shared/domain/errors";
import { Money } from "../../src/shared/domain/money";
import { FailureCode } from "../../src/wagering/domain/failure-code";
import { payloadHash } from "../../src/wagering/domain/payload-hash";
import {
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from "../../src/wagering/domain/wager-transaction";
import { LedgerDirection } from "../../src/wallet/domain/ledger-entry";

const base = {
  id: "t1",
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  idempotencyKey: "provider-a:transaction-123",
  payloadHash: "h",
  walletId: "w1",
  playerId: "p1",
  roundId: "round-987",
  gameId: "fortune-chimp",
  money: Money.from({ amount: "25.00", currency: "BRL" }),
};

describe("WagerTransaction", () => {
  it("nasce PENDING", () => {
    expect(WagerTransaction.create({ ...base, kind: K.Bet }).status).toBe(S.Pending);
  });

  it("REFUND e ROLLBACK exigem referência", () => {
    expect(() => WagerTransaction.create({ ...base, kind: K.Refund })).toThrow(DomainError);
    expect(() => WagerTransaction.create({ ...base, kind: K.Rollback })).toThrow(DomainError);
  });

  it("estados terminais não mudam", () => {
    const tx = WagerTransaction.create({ ...base, kind: K.Bet });
    tx.reject(FailureCode.InsufficientFunds);
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.markProcessed(undefined, new Date())).toThrow(InvalidTransactionStateError);
  });

  it("LOSS não afeta saldo", () => {
    expect(WagerTransaction.create({ ...base, kind: K.Loss }).affectsBalance()).toBe(false);
  });

  it("ROLLBACK inverte a direção da referência", () => {
    const bet = WagerTransaction.create({ ...base, kind: K.Bet });
    const win = WagerTransaction.create({ ...base, id: "t2", kind: K.Win });
    const rb = WagerTransaction.create({ ...base, id: "t3", kind: K.Rollback, referenceExternalTransactionId: "x" });
    expect(rb.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rb.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });
});

describe("payloadHash", () => {
  const payload = {
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    playerId: "p1",
    walletId: "w1",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
  };

  it("é independente da ordem das chaves", () => {
    const keys = Object.keys(payload).reverse() as (keyof typeof payload)[];
    const reordered = Object.fromEntries(keys.map((k) => [k, payload[k]])) as typeof payload;
    expect(payloadHash(reordered)).toBe(payloadHash(payload));
  });

  it("muda quando o payload de negócio muda (conflito, não replay)", () => {
    expect(payloadHash({ ...payload, money: { amount: "26.00", currency: "BRL" } })).not.toBe(payloadHash(payload));
  });
});
