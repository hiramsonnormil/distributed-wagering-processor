import { UseGuards, Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { randomUUIDv7 } from "bun";
import { ProviderAuthGuard } from "../../shared/auth/provider-auth.guard";
import { DomainError } from "../../shared/domain/errors";
import type { MoneyProps } from "../../shared/domain/money";
import { CreateWalletUseCase } from "../application/create-wallet.use-case";
import { WalletQueries } from "../application/wallet-queries";
import { WalletRepository } from "../infra/wallet.repository";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const assertWalletId = (id: string) => {
  if (!UUID.test(id)) throw new DomainError("WALLET_NOT_FOUND", "Wallet não encontrada");
};

@UseGuards(ProviderAuthGuard)
@Controller("wallets")
export class WalletController {
  private readonly wallets = new WalletRepository();

  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly em: EntityManager,
    private readonly queries: WalletQueries,
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
    assertWalletId(walletId);
    const wallet = await this.wallets.findById(this.em.fork(), walletId);
    if (!wallet) throw new DomainError("WALLET_NOT_FOUND", "Wallet não encontrada");
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }

  @Get(":walletId/ledger")
  async ledger(@Param("walletId") walletId: string, @Query("cursor") cursor?: string, @Query("limit") limit?: string) {
    assertWalletId(walletId);
    return this.queries.ledger(walletId, cursor || undefined, limit);
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  async reconcile(@Param("walletId") walletId: string) {
    assertWalletId(walletId);
    return this.queries.reconcile(walletId);
  }
}
