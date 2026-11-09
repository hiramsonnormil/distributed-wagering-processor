import { describe, expect, it } from "bun:test";
import { DomainError, InsufficientFundsError } from "../../src/shared/domain/errors";
import { _test, classifyError, PermanentMessageError } from "../../src/messaging/infra/wager-queue.consumer";
import { IdempotencyConflictError } from "../../src/wagering/application/submit-wager-transaction.use-case";

describe("classificação de erros do consumidor SQS", () => {
  it("erro de negócio é terminal (ack)", () => {
    expect(classifyError(new InsufficientFundsError())).toBe("BUSINESS");
    expect(classifyError(new IdempotencyConflictError())).toBe("BUSINESS");
    expect(classifyError(new DomainError("INVALID_KIND", "x"))).toBe("BUSINESS");
  });
  it("lock timeout, deadlock e banco fora são transitórios (retry)", () => {
    for (const code of ["55P03", "40P01", "57P03", "08006"]) expect(classifyError(Object.assign(new Error(), { code }))).toBe("TRANSIENT");
    expect(classifyError(new Error("ECONNREFUSED"))).toBe("TRANSIENT");
  });
  it("mensagem malformada e violação de constraint inesperada são permanentes (DLQ)", () => {
    expect(classifyError(new PermanentMessageError("x"))).toBe("PERMANENT");
    expect(classifyError(Object.assign(new Error(), { code: "23514" }))).toBe("PERMANENT");
  });
  it("envelope inválido vira PermanentMessageError", () => {
    expect(() => _test.parseMessage("not json")).toThrow(PermanentMessageError);
    expect(() => _test.parseMessage(JSON.stringify({ messageId: "m", type: "Other", data: {} }))).toThrow(PermanentMessageError);
    expect(() => _test.parseMessage(JSON.stringify({ messageId: "m", type: "WagerTransactionRequested", data: {} }))).toThrow(PermanentMessageError);
  });
});
