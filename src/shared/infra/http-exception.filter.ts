import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import type { Response } from "express";
import { DomainError, InvalidMoneyError } from "../domain/errors";
import { log } from "./logger";
import { metrics } from "./metrics";

/**
 * Mapeamento HTTP consistente (ver ARCHITECTURE.md):
 *  400 payload inválido | 404 não encontrado | 409 conflito (idempotência / wallet duplicada)
 *  422 rejeição de negócio (corpo traz failureCode) | 202 aceito pendente
 *  503 falha transitória de infraestrutura (pode reenviar)
 */
const STATUS_BY_CODE: Record<string, number> = {
  INVALID_MONEY: 400,
  INVALID_KIND: 400,
  INVALID_AMOUNT: 400,
  REFERENCE_REQUIRED: 400,
  REFERENCE_NOT_ALLOWED: 400,
  MISSING_IDEMPOTENCY_KEY: 400,
  INVALID_PAYLOAD: 400,
  INVALID_CURSOR: 400,
  INVALID_LIMIT: 400,
  WALLET_NOT_FOUND: 404,
  NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  WALLET_ALREADY_EXISTS: 409,
};

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (err instanceof HttpException) {
      res.status(err.getStatus()).json(err.getResponse());
      return;
    }
    if (err instanceof DomainError || err instanceof InvalidMoneyError) {
      res.status(STATUS_BY_CODE[err.code] ?? 422).json({ error: err.code, message: err.message });
      return;
    }
    const code = (err as { code?: string })?.code;
    if (code === "55P03" || code === "40P01") metrics.inc("lock_conflicts_total", { code });
    log.error("unexpected error", { error: (err as Error)?.message, code });
    res.setHeader("Retry-After", "1");
    res.status(503).json({ error: "TRANSIENT_FAILURE", message: "Tente novamente" });
  }
}
