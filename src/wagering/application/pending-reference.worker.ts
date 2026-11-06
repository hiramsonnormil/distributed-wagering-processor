import { Injectable } from "@nestjs/common";

/**
 * Worker agendado para transações PENDING_REFERENCE (seção 7.1).
 *
 * TODO(candidato):
 *  - selecionar pendentes com next_attempt_at <= now() usando FOR UPDATE SKIP LOCKED;
 *  - tentar resolver a referência; se achou, aplicar pelo mesmo fluxo do caso de uso;
 *  - senão: attempts + 1, next_attempt_at com backoff exponencial;
 *  - limite sugerido: 10 tentativas ou TTL de 15 min (justificar no ARCHITECTURE.md);
 *  - esgotou → REJECTED com FailureCode.ReferenceNotFound + WagerTransactionRejected na outbox.
 */
@Injectable()
export class PendingReferenceWorker {}
