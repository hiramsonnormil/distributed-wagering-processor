import { FailureCode } from "./failure-code";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "./wager-transaction";

/**
 * Regras puras de REFUND/ROLLBACK (seção 7 do desafio), sem banco.
 * O caso de uso resolve a referência e chama estas funções; assim as regras
 * podem ser testadas em unidade.
 */

/** Que kinds cada reversão pode referenciar. */
const ALLOWED_REFERENCE_KINDS: Record<string, WagerTransactionKind[]> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

export type ReferenceDecision =
  | { outcome: "WAIT" } // referência ainda não existe (ou ainda não foi resolvida) → PENDING_REFERENCE
  | { outcome: "REJECT"; failureCode: FailureCode }
  | { outcome: "APPLY" };

/**
 * Decide o que fazer com uma reversão dada a referência encontrada (ou não).
 * @param alreadyReversed true se a referência já tem uma reversão PROCESSED.
 */
export function decideReversal(
  tx: WagerTransaction,
  reference: WagerTransaction | undefined,
  alreadyReversed: boolean,
): ReferenceDecision {
  if (!tx.requiresReference()) throw new Error(`${tx.kind} não é reversão`);

  // Referência ainda não chegou: aguardar (seção 7.1).
  if (!reference) return { outcome: "WAIT" };
  // A referência existe mas também está esperando a dela (ex.: ROLLBACK de um REFUND pendente).
  if (reference.status === WagerTransactionStatus.PendingReference || reference.status === WagerTransactionStatus.Pending) {
    return { outcome: "WAIT" };
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return { outcome: "REJECT", failureCode: FailureCode.ReferenceNotProcessed };
  }

  const sameContext =
    reference.providerId === tx.providerId &&
    reference.playerId === tx.playerId &&
    reference.walletId === tx.walletId &&
    reference.money.currency === tx.money.currency &&
    reference.roundId === tx.roundId;
  if (!sameContext) return { outcome: "REJECT", failureCode: FailureCode.ReferenceMismatch };

  if (!ALLOWED_REFERENCE_KINDS[tx.kind]!.includes(reference.kind)) {
    return { outcome: "REJECT", failureCode: FailureCode.ReferenceInvalidKind };
  }
  if (!reference.money.equals(tx.money)) {
    return { outcome: "REJECT", failureCode: FailureCode.AmountMismatch };
  }
  if (alreadyReversed) return { outcome: "REJECT", failureCode: FailureCode.ReferenceAlreadyReversed };

  return { outcome: "APPLY" };
}

/** Backoff exponencial do worker de PENDING_REFERENCE. */
export const PENDING_REFERENCE_POLICY = {
  maxAttempts: Number(process.env.PENDING_REFERENCE_MAX_ATTEMPTS ?? 8),
  baseDelayMs: Number(process.env.PENDING_REFERENCE_BASE_DELAY_MS ?? 1000),
  maxDelayMs: 60_000,
  nextAttemptAt(attempts: number, now: Date): Date {
    const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempts);
    return new Date(now.getTime() + delay);
  },
};
