import { Money } from "../../shared/domain/money";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/** Lançamento imutável: sem campos mutáveis e sem métodos de transição. */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(p: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!p.money.isPositive()) throw new Error("Lançamento precisa de valor positivo");
    const entry = WalletLedgerEntry.rehydrate(p);
    if (!entry.isBalanced()) throw new Error("Lançamento desbalanceado");
    if (entry.balanceAfter.isNegative()) throw new Error("Lançamento deixaria saldo negativo");
    return entry;
  }

  static rehydrate(s: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      s.id, s.walletId, s.transactionId, s.direction, s.money, s.balanceBefore, s.balanceAfter, s.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
