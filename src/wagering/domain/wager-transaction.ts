import { InvalidTransactionStateError, DomainError } from "../../shared/domain/errors";
import { Money } from "../../shared/domain/money";
import { LedgerDirection } from "../../wallet/domain/ledger-entry";
import { FailureCode } from "./failure-code";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

const TERMINAL = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Transições válidas (o resto é erro de programação). */
const TRANSITIONS: Record<WagerTransactionStatus, WagerTransactionStatus[]> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.PendingReference, // nova tentativa do worker
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState extends Required<Omit<CreateWagerTransactionProps, "referenceExternalTransactionId">> {
  referenceExternalTransactionId?: string;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência por kind. */
  static create(p: CreateWagerTransactionProps): WagerTransaction {
    const requiresRef = p.kind === WagerTransactionKind.Refund || p.kind === WagerTransactionKind.Rollback;
    if (requiresRef && !p.referenceExternalTransactionId) {
      throw new DomainError("REFERENCE_REQUIRED", `${p.kind} exige referenceExternalTransactionId`);
    }
    if (!requiresRef && p.kind !== WagerTransactionKind.Win && p.referenceExternalTransactionId) {
      throw new DomainError("REFERENCE_NOT_ALLOWED", `${p.kind} não aceita referência`);
    }
    if (!p.money.isPositive()) {
      throw new DomainError("INVALID_AMOUNT", "Valor da transação deve ser > 0");
    }
    return new WagerTransaction(
      p.id, p.providerId, p.externalTransactionId, p.idempotencyKey, p.payloadHash, p.walletId, p.playerId,
      p.roundId, p.gameId, p.kind, p.money, p.referenceExternalTransactionId, p.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id, s.providerId, s.externalTransactionId, s.idempotencyKey, s.payloadHash, s.walletId, s.playerId,
      s.roundId, s.gameId, s.kind, s.money, s.referenceExternalTransactionId, s.createdAt, s.status,
      s.referenceTransactionId, s.failureCode, s.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.transition(WagerTransactionStatus.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.transition(WagerTransactionStatus.PendingReference);
  }

  reject(code: FailureCode): void {
    this.transition(WagerTransactionStatus.Rejected);
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.transition(WagerTransactionStatus.Failed);
    this._failureCode = code;
  }

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** BET debita; WIN/REFUND/OPENING creditam; ROLLBACK inverte a referência. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new Error("ROLLBACK precisa da referência resolvida");
        const refDir = reference.ledgerDirectionFor();
        return refDir === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new Error("LOSS não gera lançamento");
    }
  }

  private transition(to: WagerTransactionStatus): void {
    if (!TRANSITIONS[this._status].includes(to)) {
      throw new InvalidTransactionStateError(this._status, to);
    }
    this._status = to;
  }
}
