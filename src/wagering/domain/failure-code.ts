/**
 * Taxonomia de falhas, estável e legível por máquina.
 * - retryable=false: o provedor NÃO deve reenviar o mesmo payload.
 * Documentada em ARCHITECTURE.md.
 */
export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS", // BET sem saldo
  ReversalWouldOverdraw = "REVERSAL_WOULD_OVERDRAW", // ROLLBACK de WIN/REFUND deixaria saldo negativo
  CurrencyMismatch = "CURRENCY_MISMATCH",
  WalletNotFound = "WALLET_NOT_FOUND",
  WalletOwnershipMismatch = "WALLET_OWNERSHIP_MISMATCH", // playerId não é dono da wallet
  ReferenceNotFound = "REFERENCE_NOT_FOUND", // esgotou PENDING_REFERENCE
  ReferenceMismatch = "REFERENCE_MISMATCH", // provider/player/wallet/moeda/rodada diferentes
  ReferenceInvalidKind = "REFERENCE_INVALID_KIND", // ex.: REFUND referenciando WIN
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  AmountMismatch = "AMOUNT_MISMATCH", // reversão com valor diferente da referência
  InfrastructurePermanent = "INFRASTRUCTURE_PERMANENT", // usado em FAILED
}
