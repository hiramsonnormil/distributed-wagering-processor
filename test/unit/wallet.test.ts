import { describe, expect, it } from "bun:test";
import { CurrencyMismatchError, InsufficientFundsError } from "../../src/shared/domain/errors";
import { Money } from "../../src/shared/domain/money";
import { LedgerDirection } from "../../src/wallet/domain/ledger-entry";
import { Wallet } from "../../src/wallet/domain/wallet";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const open = (amount = "100.00") =>
  Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl(amount), openingTransactionId: "open-1" });

describe("Wallet", () => {
  it("abre com version 1 e lançamento OPENING", () => {
    const { wallet, openingEntry } = open();
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe("100.00");
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.isBalanced()).toBe(true);
  });

  it("saldo inicial zero não gera lançamento", () => {
    const { wallet, openingEntry } = open("0.00");
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  it("debita e gera um lançamento consistente", () => {
    const { wallet } = open();
    const entry = wallet.debit(brl("80.00"), "tx-1");
    expect(wallet.balance.toString()).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(entry.balanceBefore.toString()).toBe("100.00");
    expect(entry.balanceAfter.toString()).toBe("20.00");
  });

  it("não permite saldo negativo nem altera version na rejeição", () => {
    const { wallet } = open();
    wallet.debit(brl("80.00"), "tx-1");
    expect(() => wallet.debit(brl("80.00"), "tx-2")).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe("20.00");
    expect(wallet.version).toBe(2);
  });

  it("rejeita moeda diferente da wallet", () => {
    const { wallet } = open();
    expect(() => wallet.credit(Money.from({ amount: "1.00", currency: "USD" }), "tx")).toThrow(CurrencyMismatchError);
  });

  it("saldo == reconstrução pelo ledger", () => {
    const { wallet, openingEntry } = open();
    const entries = [openingEntry!, wallet.debit(brl("30.00"), "a"), wallet.credit(brl("12.50"), "b")];
    const rebuilt = entries.reduce(
      (acc, e) => (e.direction === LedgerDirection.Credit ? acc.add(e.money) : acc.subtract(e.money)),
      Money.zero("BRL"),
    );
    expect(rebuilt.equals(wallet.balance)).toBe(true);
  });

  it("lançamento é imutável", () => {
    const { wallet } = open();
    const entry = wallet.debit(brl("1.00"), "tx");
    expect(Object.isFrozen(entry)).toBe(true);
  });
});
