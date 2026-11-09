import { UseGuards, Body, Controller, Get, Headers, Param, Post, Res } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { randomUUIDv7 } from "bun";
import type { Response } from "express";
import { ProviderAuthGuard } from "../../shared/auth/provider-auth.guard";
import { DomainError } from "../../shared/domain/errors";
import { SubmitWagerTransactionUseCase, type SubmitWagerInput } from "../application/submit-wager-transaction.use-case";
import { WagerTransactionStatus } from "../domain/wager-transaction";
import { WagerTransactionRepository, type WagerTransactionRow } from "../infra/wager-transaction.repository";

const view = (r: WagerTransactionRow) => ({
  transactionId: r.id,
  providerId: r.provider_id,
  externalTransactionId: r.external_transaction_id,
  walletId: r.wallet_id,
  kind: r.kind,
  money: { amount: r.amount, currency: r.currency },
  status: r.status,
  failureCode: r.failure_code ?? undefined,
});

@UseGuards(ProviderAuthGuard)
@Controller()
export class WageringController {
  private readonly transactions = new WagerTransactionRepository();

  constructor(
    private readonly submit: SubmitWagerTransactionUseCase,
    private readonly em: EntityManager,
  ) {}

  @Post("wagering/transactions")
  async create(
    @Body() body: Omit<SubmitWagerInput, "idempotencyKey" | "correlationId">,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-correlation-id") correlationId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey) throw new DomainError("MISSING_IDEMPOTENCY_KEY", "Header Idempotency-Key é obrigatório");
    const result = await this.submit.execute({ ...body, idempotencyKey, correlationId: correlationId ?? randomUUIDv7() });

    if (result.status === WagerTransactionStatus.Rejected) res.status(422);
    else if (result.status === WagerTransactionStatus.PendingReference) res.status(202);
    else res.status(result.idempotentReplay ? 200 : 201);
    return result;
  }

  @Get("wagering/transactions/:transactionId")
  async byId(@Param("transactionId") id: string) {
    const row = await this.transactions.findById(this.em.fork(), id);
    if (!row) throw new DomainError("NOT_FOUND", "Transação não encontrada");
    return view(row);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async byExternal(@Param("providerId") providerId: string, @Param("externalTransactionId") externalId: string) {
    const row = await this.transactions.findByExternal(this.em.fork(), providerId, externalId);
    if (!row) throw new DomainError("NOT_FOUND", "Transação não encontrada");
    return view(row);
  }
}
