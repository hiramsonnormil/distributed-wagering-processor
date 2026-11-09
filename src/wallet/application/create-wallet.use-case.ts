import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { randomUUIDv7 } from "bun";
import { DomainError } from "../../shared/domain/errors";
import { Money, type MoneyProps } from "../../shared/domain/money";
import { WalletBalanceChanged } from "../../messaging/domain/events";
import { enqueueOutbox } from "../../messaging/infra/outbox.writer";
import { payloadHash } from "../../wagering/domain/payload-hash";
import { WagerTransaction, WagerTransactionKind } from "../../wagering/domain/wager-transaction";
import { WagerTransactionRepository } from "../../wagering/infra/wager-transaction.repository";
import { Wallet } from "../domain/wallet";
import { WalletRepository } from "../infra/wallet.repository";

export class WalletAlreadyExistsError extends DomainError {
  constructor() {
    super("WALLET_ALREADY_EXISTS", "Já existe wallet para este playerId + currency");
  }
}

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

@Injectable()
export class CreateWalletUseCase {
  private readonly wallets = new WalletRepository();
  private readonly transactions = new WagerTransactionRepository();

  constructor(private readonly em: EntityManager) {}

  async execute(input: CreateWalletInput): Promise<Wallet> {
    if (typeof input.playerId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.playerId)) {
      throw new DomainError("INVALID_PAYLOAD", "playerId deve ser UUID");
    }
    if (!input.initialBalance || typeof input.initialBalance !== "object") {
      throw new DomainError("INVALID_PAYLOAD", "initialBalance é obrigatório");
    }
    const initialBalance = Money.from(input.initialBalance);
    const now = new Date();
    const walletId = randomUUIDv7();
    const openingId = randomUUIDv7();
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: input.playerId,
      initialBalance,
      openingTransactionId: openingId,
      now,
    });

    try {
      // Wallet + OPENING + ledger + outbox na MESMA transação SQL.
      await this.em.fork().transactional(async (em) => {
        await this.wallets.insert(em, wallet);
        if (!openingEntry) return;

        const opening = WagerTransaction.create({
          id: openingId,
          providerId: "internal",
          externalTransactionId: `opening:${walletId}`,
          idempotencyKey: `internal:opening:${walletId}`,
          payloadHash: payloadHash({
            providerId: "internal",
            externalTransactionId: `opening:${walletId}`,
            playerId: input.playerId,
            walletId,
            roundId: "opening",
            gameId: "internal",
            kind: WagerTransactionKind.Opening,
            money: initialBalance.toJSON(),
          }),
          walletId,
          playerId: input.playerId,
          roundId: "opening",
          gameId: "internal",
          kind: WagerTransactionKind.Opening,
          money: initialBalance,
          createdAt: now,
        });
        await this.transactions.tryInsert(em, opening);
        opening.markProcessed(undefined, now);
        await this.transactions.saveOutcome(em, opening, wallet.balance);
        await this.wallets.insertLedgerEntry(em, openingEntry);
        await enqueueOutbox(em, [WalletBalanceChanged.from(wallet, openingEntry, { correlationId: input.correlationId, now })]);
      });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new WalletAlreadyExistsError();
      throw err;
    }
    return wallet;
  }
}
