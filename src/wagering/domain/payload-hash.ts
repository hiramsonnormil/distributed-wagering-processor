import { createHash } from "node:crypto";

/** Campos de negócio que entram no hash (header e metadados de transporte ficam de fora). */
export interface HashablePayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

/** JSON canônico: chaves ordenadas recursivamente, sem undefined. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** SHA-256 hex do JSON canônico do subconjunto de negócio. */
export function payloadHash(p: HashablePayload): string {
  const subset: HashablePayload = {
    providerId: p.providerId,
    externalTransactionId: p.externalTransactionId,
    playerId: p.playerId,
    walletId: p.walletId,
    roundId: p.roundId,
    gameId: p.gameId,
    kind: p.kind,
    money: { amount: p.money.amount, currency: p.money.currency },
    referenceExternalTransactionId: p.referenceExternalTransactionId,
  };
  return createHash("sha256").update(canonicalJson(subset)).digest("hex");
}
