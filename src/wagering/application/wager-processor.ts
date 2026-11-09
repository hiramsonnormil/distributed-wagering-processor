import type { EntityManager } from "@mikro-orm/postgresql";
import { InsufficientFundsError } from "../../shared/domain/errors";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type EventContext,
} from "../../messaging/domain/events";
import type { IntegrationEvent } from "../../messaging/domain/integration-event";
import { LedgerDirection } from "../../wallet/domain/ledger-entry";
import type { Wallet } from "../../wallet/domain/wallet";
import { WalletRepository } from "../../wallet/infra/wallet.repository";
import { FailureCode } from "../domain/failure-code";
import { decideReversal } from "../domain/reference-policy";
import { WagerTransaction, WagerTransactionKind } from "../domain/wager-transaction";
import { WagerTransactionRepository } from "../infra/wager-transaction.repository";

export type ProcessOutcome = "APPLIED" | "REJECTED" | "WAITING_REFERENCE";

/**
 * Aplica UMA transação já persistida (PENDING ou PENDING_REFERENCE) sobre a wallet já travada.
 * Usado pelo caso de uso (HTTP e SQS) e pelo worker de PENDING_REFERENCE, para que a regra
 * financeira exista em um só lugar.
 *
 * Pré-condição: chamado dentro de em.transactional(), com a wallet travada (FOR UPDATE).
 * Não grava o resultado da transação: quem chama faz saveOutcome + outbox na mesma transação.
 */
export class WagerProcessor {
  private readonly wallets = new WalletRepository();
  private readonly transactions = new WagerTransactionRepository();

  async process(
    em: EntityManager,
    tx: WagerTransaction,
    wallet: Wallet,
    ctx: EventContext,
    events: IntegrationEvent<unknown>[],
  ): Promise<ProcessOutcome> {
    const reject = (code: FailureCode): ProcessOutcome => {
      tx.reject(code);
      events.push(WagerTransactionRejected.from(tx, ctx));
      return "REJECTED";
    };

    if (wallet.playerId !== tx.playerId) return reject(FailureCode.WalletOwnershipMismatch);
    if (tx.money.currency !== wallet.currency) return reject(FailureCode.CurrencyMismatch);

    // ---- REFUND / ROLLBACK
    if (tx.requiresReference()) {
      const reference = await this.transactions.findReference(em, tx.providerId, tx.referenceExternalTransactionId!);
      const alreadyReversed = reference ? await this.transactions.isAlreadyReversed(em, reference.id) : false;
      const decision = decideReversal(tx, reference, alreadyReversed);

      if (decision.outcome === "WAIT") return "WAITING_REFERENCE";
      if (decision.outcome === "REJECT") return reject(decision.failureCode);

      const direction = tx.ledgerDirectionFor(reference);
      const ok = await this.move(em, tx, wallet, direction, ctx, events, reference!.id);
      // Reversão que deixaria saldo negativo tem código PRÓPRIO (≠ aposta sem saldo).
      return ok ? "APPLIED" : reject(FailureCode.ReversalWouldOverdraw);
    }

    // ---- LOSS: registra o resultado sem mover saldo e sem ledger
    if (!tx.affectsBalance()) {
      tx.markProcessed(undefined, ctx.now);
      events.push(WagerTransactionProcessed.from(tx, ctx));
      return "APPLIED";
    }

    // ---- BET / WIN
    let referenceId: string | undefined;
    if (tx.kind === WagerTransactionKind.Win && tx.referenceExternalTransactionId) {
      // WIN "pode referenciar a BET da mesma rodada": vinculamos quando existe e bate; não bloqueia.
      const bet = await this.transactions.findReference(em, tx.providerId, tx.referenceExternalTransactionId);
      if (bet && bet.kind === WagerTransactionKind.Bet && bet.walletId === tx.walletId && bet.roundId === tx.roundId) {
        referenceId = bet.id;
      }
    }
    const direction = tx.ledgerDirectionFor();
    const ok = await this.move(em, tx, wallet, direction, ctx, events, referenceId);
    return ok ? "APPLIED" : reject(FailureCode.InsufficientFunds);
  }

  /** Débito/crédito + UPDATE condicionado à versão + lançamento no ledger. false = saldo insuficiente. */
  private async move(
    em: EntityManager,
    tx: WagerTransaction,
    wallet: Wallet,
    direction: LedgerDirection,
    ctx: EventContext,
    events: IntegrationEvent<unknown>[],
    referenceTransactionId: string | undefined,
  ): Promise<boolean> {
    const versionBefore = wallet.version;
    let entry;
    try {
      entry = direction === LedgerDirection.Debit
        ? wallet.debit(tx.money, tx.id, ctx.now)
        : wallet.credit(tx.money, tx.id, ctx.now);
    } catch (err) {
      if (err instanceof InsufficientFundsError) return false;
      throw err;
    }
    await this.wallets.updateBalance(em, wallet, versionBefore);
    await this.wallets.insertLedgerEntry(em, entry);
    tx.markProcessed(referenceTransactionId, ctx.now);
    events.push(WagerTransactionProcessed.from(tx, ctx), WalletBalanceChanged.from(wallet, entry, ctx));
    return true;
  }

  /** Evento de "aguardando referência". */
  static pendingEvent(tx: WagerTransaction, ctx: EventContext) {
    return WagerTransactionPendingReference.from(tx, ctx);
  }
}
