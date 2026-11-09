import { Inject, Injectable, Optional, type BeforeApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { log } from "../../shared/infra/logger";
import { metrics } from "../../shared/infra/metrics";
import { OutboxMessage } from "../domain/outbox-message";
import { EVENT_PUBLISHER, SqsEventPublisher, type EventPublisherPort } from "./event-publisher";

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date | null;
  published_at: Date | null;
}

/**
 * Worker da Transactional Outbox.
 *
 * Cada rodada, numa transação curta:
 *   select ... where published_at is null and next_attempt_at <= now()
 *   order by occurred_at limit N
 *   for update skip locked      -- vários publishers concorrentes NÃO pegam a mesma linha
 * publica cada evento; sucesso → published_at; falha → OutboxMessage.scheduleRetry (backoff).
 *
 * Crash depois do commit do caso de uso e antes de publicar: a linha continua pendente e
 * qualquer instância publica na próxima rodada. Crash depois de publicar e antes de marcar:
 * o lock some com a conexão e a linha é publicada de novo → at-least-once; o consumidor
 * deduplica por eventId (e o SQS FIFO deduplica por MessageDeduplicationId na janela de 5 min).
 */
@Injectable()
export class OutboxPublisher implements OnModuleInit, BeforeApplicationShutdown {
  private timer?: ReturnType<typeof setInterval>;
  private running: Promise<number> | undefined;
  private readonly publisher: EventPublisherPort;

  constructor(
    private readonly em: EntityManager,
    @Optional() @Inject(EVENT_PUBLISHER) publisher?: EventPublisherPort,
  ) {
    this.publisher = publisher ?? new SqsEventPublisher();
  }

  onModuleInit() {
    if (process.env.OUTBOX_PUBLISHER_ENABLED === "false") return;
    const every = Number(process.env.OUTBOX_POLL_MS ?? 500);
    this.timer = setInterval(() => {
      if (!this.running) this.running = this.tick().finally(() => (this.running = undefined));
    }, every);
  }

  async beforeApplicationShutdown() {
    clearInterval(this.timer);
    await this.running; // termina a rodada em andamento antes de fechar o pool
  }

  /** Uma rodada. Retorna quantas mensagens foram publicadas. Público para testes. */
  async tick(batch = Number(process.env.OUTBOX_BATCH_SIZE ?? 50)): Promise<number> {
    try {
      const published = await this.em.fork().transactional(async (em) => {
        const rows = await em.execute<OutboxRow[]>(
          `select * from outbox_messages
            where published_at is null and next_attempt_at <= now()
            order by occurred_at
            limit ?
            for update skip locked`,
          [batch],
        );
        let ok = 0;
        for (const row of rows) {
          const msg = OutboxMessage.rehydrate({
            id: row.id,
            aggregateId: row.aggregate_id,
            eventType: row.event_type,
            payload: row.payload,
            occurredAt: row.occurred_at,
            attempts: row.attempts,
            nextAttemptAt: row.next_attempt_at ?? undefined,
          });
          const started = performance.now();
          try {
            await this.publisher.publish(msg);
            msg.markPublished(new Date());
            await em.execute(`update outbox_messages set published_at = ? where id = ?`, [msg.publishedAt, msg.id]);
            metrics.inc("outbox_published_total", { eventType: msg.eventType });
            metrics.observe("outbox_publish_ms", performance.now() - started);
            ok++;
          } catch (err) {
            msg.scheduleRetry(new Date());
            await em.execute(`update outbox_messages set attempts = ?, next_attempt_at = ? where id = ?`, [
              msg.attempts, msg.nextAttemptAt, msg.id,
            ]);
            metrics.inc("outbox_publish_retries_total", { eventType: msg.eventType });
            log.warn("outbox publish failed", { eventId: msg.id, eventType: msg.eventType, attempts: msg.attempts, error: (err as Error).message });
          }
        }
        return ok;
      });
      await this.measureLag();
      return published;
    } catch (err) {
      log.error("outbox publisher round failed", { error: (err as Error).message });
      return 0;
    }
  }

  /** Outbox lag = idade (s) da mensagem pendente mais antiga. */
  private async measureLag() {
    const rows = await this.em.fork().execute<{ lag: string | null; pending: string }[]>(
      `select extract(epoch from now() - min(occurred_at)) as lag, count(*) as pending
         from outbox_messages where published_at is null`,
    );
    metrics.gauge("outbox_lag_seconds", Number(rows[0]?.lag ?? 0));
    metrics.gauge("outbox_pending_messages", Number(rows[0]?.pending ?? 0));
  }
}
