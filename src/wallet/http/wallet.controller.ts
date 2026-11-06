import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { randomUUIDv7 } from "bun";
import { DomainError } from "../../shared/domain/errors";
import type { MoneyProps } from "../../shared/domain/money";
import { CreateWalletUseCase } from "../application/create-wallet.use-case";
import { WalletRepository } from "../infra/wallet.repository";

@Controller("wallets")
export class WalletController {
  private readonly wallets = new WalletRepository();

  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly em: EntityManager,
  ) {}

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: { playerId: string; initialBalance: MoneyProps },
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    const wallet = await this.createWallet.execute({
      playerId: body?.playerId,
      initialBalance: body?.initialBalance,
      correlationId: correlationId ?? randomUUIDv7(),
    });
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string) {
    const wallet = await this.wallets.findById(this.em.fork(), walletId);
    if (!wallet) throw new DomainError("WALLET_NOT_FOUND", "Wallet não encontrada");
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }

  @Get(":walletId/ledger")
  async ledger(@Param("walletId") _walletId: string, @Query("cursor") _cursor?: string, @Query("limit") _limit?: string) {
    // TODO(candidato): paginação por cursor opaco = base64(created_at|id), ordenando por (created_at, id).
    throw new DomainError("NOT_IMPLEMENTED", "Ledger paginado ainda não implementado");
  }

  @Post(":walletId/reconciliation")
  async reconcile(@Param("walletId") _walletId: string) {
    // TODO(candidato): comparar wallets.balance com o saldo reconstruído pelo ledger
    // (soma CREDIT - soma DEBIT), logar + métrica se divergir, nunca corrigir silenciosamente.
    throw new DomainError("NOT_IMPLEMENTED", "Reconciliação ainda não implementada");
  }
}
