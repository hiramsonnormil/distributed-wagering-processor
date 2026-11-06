import { randomUUIDv7 } from "bun";
import type { MoneyProps } from "../../shared/domain/money";
import type { LedgerDirection, WalletLedgerEntry } from "../../wallet/domain/ledger-entry";
import type { Wallet } from "../../wallet/domain/wallet";
import type { WagerTransaction } from "../../wagering/domain/wager-transaction";
import { IntegrationEvent } from "./integration-event";

export interface EventContext {
  correlationId: string;
  causationId?: string;
  now: Date;
}

const base = (aggregateId: string, ctx: EventContext) => ({
  eventId: randomUUIDv7(),
  aggregateId,
  correlationId: ctx.correlationId,
  causationId: ctx.causationId,
  occurredAt: ctx.now,
});

interface TransactionData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode?: string;
}

const txData = (tx: WagerTransaction): TransactionData => ({
  transactionId: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  walletId: tx.walletId,
  kind: tx.kind,
  money: tx.money.toJSON(),
  status: tx.status,
  failureCode: tx.failureCode,
});

export class WagerTransactionProcessed extends IntegrationEvent<TransactionData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;
  static from(tx: WagerTransaction, ctx: EventContext) {
    return new WagerTransactionProcessed({ ...base(tx.id, ctx), data: txData(tx) });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<TransactionData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;
  static from(tx: WagerTransaction, ctx: EventContext) {
    return new WagerTransactionRejected({ ...base(tx.id, ctx), data: txData(tx) });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<TransactionData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;
  static from(tx: WagerTransaction, ctx: EventContext) {
    return new WagerTransactionPendingReference({ ...base(tx.id, ctx), data: txData(tx) });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext) {
    return new WalletBalanceChanged({
      ...base(wallet.id, ctx),
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
