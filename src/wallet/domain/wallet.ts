import { randomUUIDv7 } from "bun";
import { CurrencyMismatchError, InsufficientFundsError } from "../../shared/domain/errors";
import { Money } from "../../shared/domain/money";
import { LedgerDirection, WalletLedgerEntry } from "./ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Aggregate root. Toda alteração de saldo produz exatamente um lançamento. */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet. Se o saldo inicial for > 0, gera o lançamento CREDIT da transação
   * interna OPENING (mesma transação SQL no caso de uso). `version` termina em 1.
   */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    openingTransactionId: string;
    now?: Date;
  }): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    const now = props.now ?? new Date();
    const currency = props.initialBalance.currency;
    if (props.initialBalance.isNegative()) throw new Error("Saldo inicial negativo");
    const wallet = new Wallet(props.id, props.playerId, currency, Money.zero(currency), 0, now, now);
    if (props.initialBalance.isZero()) {
      wallet._version = 1;
      return { wallet };
    }
    const openingEntry = wallet.credit(props.initialBalance, props.openingTransactionId, now);
    return { wallet, openingEntry }; // version 0 -> 1
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(s: WalletState): Wallet {
    return new Wallet(s.id, s.playerId, s.currency, s.balance, s.version, s.createdAt, s.updatedAt);
  }

  get balance(): Money {
    return this._balance;
  }
  get version(): number {
    return this._version;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(money: Money, transactionId: string, at = new Date()): WalletLedgerEntry {
    this.assertSameCurrency(money);
    if (this._balance.isLessThan(money)) throw new InsufficientFundsError();
    return this.apply(LedgerDirection.Debit, money, transactionId, at);
  }

  credit(money: Money, transactionId: string, at = new Date()): WalletLedgerEntry {
    this.assertSameCurrency(money);
    return this.apply(LedgerDirection.Credit, money, transactionId, at);
  }

  private apply(direction: LedgerDirection, money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(money) : before.subtract(money);
    const entry = WalletLedgerEntry.create({
      id: randomUUIDv7(),
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: at,
    });
    this._balance = after;
    this._version += 1; // só incrementa quando o saldo muda
    this._updatedAt = at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new CurrencyMismatchError(this.currency, money.currency);
  }
}
