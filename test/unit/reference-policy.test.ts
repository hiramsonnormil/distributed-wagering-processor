import { describe, expect, it } from "bun:test";
import { Money } from "../../src/shared/domain/money";
import { FailureCode } from "../../src/wagering/domain/failure-code";
import { decideReversal, PENDING_REFERENCE_POLICY } from "../../src/wagering/domain/reference-policy";
import {
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from "../../src/wagering/domain/wager-transaction";
import { LedgerDirection } from "../../src/wallet/domain/ledger-entry";

const brl = (a: string) => Money.from({ amount: a, currency: "BRL" });
let seq = 0;
const make = (kind: K, over: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) =>
  WagerTransaction.create({
    id: `t${++seq}`,
    providerId: "provider-a",
    externalTransactionId: `ext-${seq}`,
    idempotencyKey: `provider-a:ext-${seq}`,
    payloadHash: "h",
    walletId: "w1",
    playerId: "p1",
    roundId: "round-1",
    gameId: "g",
    kind,
    money: brl("25.00"),
    referenceExternalTransactionId: kind === K.Refund || kind === K.Rollback ? "ext-ref" : undefined,
    ...over,
  });
/** failureCode da decisão (undefined quando não é REJECT). */
const fc = (d: ReturnType<typeof decideReversal>) => (d.outcome === "REJECT" ? d.failureCode : undefined);
const processed = (tx: WagerTransaction) => {
  tx.markProcessed(undefined, new Date());
  return tx;
};

describe("REFUND / ROLLBACK — decideReversal", () => {
  it("referência ausente → WAIT (vira PENDING_REFERENCE)", () => {
    expect(decideReversal(make(K.Refund), undefined, false)).toEqual({ outcome: "WAIT" });
  });

  it("referência que também está PENDING_REFERENCE → WAIT", () => {
    const ref = make(K.Refund);
    ref.markPendingReference();
    expect(decideReversal(make(K.Rollback), ref, false).outcome).toBe("WAIT");
  });

  it("REFUND de BET processada → APPLY e credita", () => {
    const bet = processed(make(K.Bet));
    const refund = make(K.Refund);
    expect(decideReversal(refund, bet, false).outcome).toBe("APPLY");
    expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
  });

  it("REFUND só referencia BET", () => {
    const win = processed(make(K.Win));
    expect(decideReversal(make(K.Refund), win, false)).toEqual({ outcome: "REJECT", failureCode: FailureCode.ReferenceInvalidKind });
  });

  it("ROLLBACK aceita BET, WIN e REFUND; direção é a inversa da referência", () => {
    const bet = processed(make(K.Bet));
    const win = processed(make(K.Win));
    const rb = make(K.Rollback);
    expect(decideReversal(rb, bet, false).outcome).toBe("APPLY");
    expect(rb.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(decideReversal(rb, win, false).outcome).toBe("APPLY");
    expect(rb.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });

  it("ROLLBACK de LOSS é rejeitado", () => {
    const loss = processed(make(K.Loss));
    expect(fc(decideReversal(make(K.Rollback), loss, false))).toBe(FailureCode.ReferenceInvalidKind);
  });

  it("valor diferente da referência → AMOUNT_MISMATCH (sem reversão parcial)", () => {
    const bet = processed(make(K.Bet));
    expect(fc(decideReversal(make(K.Refund, { money: brl("10.00") }), bet, false))).toBe(FailureCode.AmountMismatch);
  });

  it.each([
    ["playerId", { playerId: "p2" }],
    ["walletId", { walletId: "w2" }],
    ["roundId", { roundId: "round-2" }],
    ["providerId", { providerId: "provider-b" }],
  ] as const)("referência de outro %s → REFERENCE_MISMATCH", (_f, over) => {
    const bet = processed(make(K.Bet, over));
    expect(fc(decideReversal(make(K.Refund), bet, false))).toBe(FailureCode.ReferenceMismatch);
  });

  it("referência em outra moeda → REFERENCE_MISMATCH", () => {
    const bet = processed(make(K.Bet, { money: Money.from({ amount: "25.00", currency: "USD" }) }));
    expect(fc(decideReversal(make(K.Refund), bet, false))).toBe(FailureCode.ReferenceMismatch);
  });

  it("referência REJECTED → REFERENCE_NOT_PROCESSED", () => {
    const bet = make(K.Bet);
    bet.reject(FailureCode.InsufficientFunds);
    expect(fc(decideReversal(make(K.Refund), bet, false))).toBe(FailureCode.ReferenceNotProcessed);
  });

  it("referência já revertida → REFERENCE_ALREADY_REVERSED", () => {
    const bet = processed(make(K.Bet));
    expect(fc(decideReversal(make(K.Rollback), bet, true))).toBe(FailureCode.ReferenceAlreadyReversed);
  });

  it("BET não é reversão", () => {
    expect(() => decideReversal(make(K.Bet), undefined, false)).toThrow();
  });
});

describe("PENDING_REFERENCE backoff", () => {
  it("cresce exponencialmente e respeita o teto", () => {
    const now = new Date(0);
    const d = (n: number) => PENDING_REFERENCE_POLICY.nextAttemptAt(n, now).getTime();
    expect(d(1)).toBe(2 * PENDING_REFERENCE_POLICY.baseDelayMs);
    expect(d(2)).toBe(4 * PENDING_REFERENCE_POLICY.baseDelayMs);
    expect(d(30)).toBe(PENDING_REFERENCE_POLICY.maxDelayMs);
  });
});

describe("transições", () => {
  it("PENDING_REFERENCE pode ir para PROCESSED ou REJECTED", () => {
    const a = make(K.Refund);
    a.markPendingReference();
    a.markProcessed("t-ref", new Date());
    expect(a.status).toBe(S.Processed);
    const b = make(K.Refund);
    b.markPendingReference();
    b.reject(FailureCode.ReferenceNotFound);
    expect(b.failureCode).toBe(FailureCode.ReferenceNotFound);
  });
});
