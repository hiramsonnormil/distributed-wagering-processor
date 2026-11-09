import { Injectable, type BeforeApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { randomUUIDv7 } from "bun";
import { log } from "../../shared/infra/logger";
import { metrics } from "../../shared/infra/metrics";
import { WagerTransactionRejected, type EventContext } from "../../messaging/domain/events";
import type { IntegrationEvent } from "../../messaging/domain/integration-event";
import { enqueueOutbox } from "../../messaging/infra/outbox.writer";
import { WalletRepository } from "../../wallet/infra/wallet.repository";
import { FailureCode } from "../domain/failure-code";
import { PENDING_REFERENCE_POLICY } from "../domain/reference-policy";
import { WagerTransactionStatus } from "../domain/wager-transaction";
import { rowToTransaction, WagerTransactionRepository } from "../infra/wager-transaction.repository";
import { WagerProcessor } from "./wager-processor";

/**
 * Worker agendado para transações PENDING_REFERENCE (seção 7.1).
 *
 * - Busca as vencidas (next_attempt_at <= now()).
 * - Para cada uma, numa transação própria: lock da WALLET primeiro (mesma ordem do caso de uso,
 *   evita deadlock), depois lock da transação com SKIP LOCKED (outra instância já pegou → pula).
 * - Referência apareceu → aplica pelo MESMO WagerProcessor do caso de uso.
 * - Não apareceu → attempts + 1 e backoff exponencial (1s, 2s, 4s ... teto 60s).
 * - Esgotou PENDING_REFERENCE_MAX_ATTEMPTS (default 8 ≈ 4 min) → REJECTED com REFERENCE_NOT_FOUND
 *   e evento WagerTransactionRejected na outbox.
 */
@Injectable()
export class PendingReferenceWorker implements OnModuleInit, BeforeApplicationShutdown {
  private timer?: ReturnType<typeof setInterval>;
  private running: Promise<number> | undefined;
  private readonly wallets = new WalletRepository();
  private readonly transactions = new WagerTransactionRepository();
  private readonly processor = new WagerProcessor();

  constructor(private readonly em: EntityManager) {}

  onModuleInit() {
    if (process.env.PENDING_REFERENCE_WORKER_ENABLED === "false") return;
    const every = Number(process.env.PENDING_REFERENCE_POLL_MS ?? 1000);
    this.timer = setInterval(() => {
      if (!this.running) this.running = this.tick().finally(() => (this.running = undefined));
    }, every);
  }

  async beforeApplicationShutdown() {
    clearInterval(this.timer);
    await this.running;
  }

  /** Uma rodada do worker. Público para os testes chamarem de forma determinística. */
  async tick(batch = 20): Promise<number> {
    let handled = 0;
    try {
      const due = await this.transactions.findDuePendingReference(this.em.fork(), batch);
      for (const item of due) {
        if (await this.resolveOne(item.id, item.wallet_id)) handled++;
      }
    } catch (err) {
      log.error("pending reference worker failed", { error: (err as Error).message });
    }
    return handled;
  }

  private async resolveOne(id: string, walletId: string): Promise<boolean> {
    return this.em.fork().transactional(async (em) => {
      const wallet = await this.wallets.lockById(em, walletId);
      if (!wallet) return false;
      const row = await this.transactions.lockPendingReference(em, id);
      if (!row) return false; // outra instância pegou, ou já foi resolvida

      const tx = rowToTransaction(row);
      const now = new Date();
      const ctx: EventContext = { correlationId: randomUUIDv7(), causationId: tx.id, now };
      const events: IntegrationEvent<unknown>[] = [];
      const outcome = await this.processor.process(em, tx, wallet, ctx, events);

      if (outcome === "WAITING_REFERENCE") {
        const attempts = row.attempts + 1;
        metrics.inc("pending_reference_retries_total");
        if (attempts >= PENDING_REFERENCE_POLICY.maxAttempts) {
          tx.reject(FailureCode.ReferenceNotFound);
          events.push(WagerTransactionRejected.from(tx, ctx));
          log.warn("reference not found, giving up", { transactionId: tx.id, walletId, providerId: tx.providerId, attempts });
        } else {
          await this.transactions.schedulePendingReference(em, tx.id, attempts, PENDING_REFERENCE_POLICY.nextAttemptAt(attempts, now));
          return false;
        }
      }

      await this.transactions.saveOutcome(em, tx, wallet.balance);
      if (tx.status === WagerTransactionStatus.Processed) {
        await this.transactions.wakeDependents(em, tx.providerId, tx.externalTransactionId);
      }
      await enqueueOutbox(em, events);
      metrics.inc("wager_transactions_total", { status: tx.status, kind: tx.kind });
      log.info("pending reference resolved", { transactionId: tx.id, walletId, providerId: tx.providerId, status: tx.status });
      return true;
    });
  }
}
