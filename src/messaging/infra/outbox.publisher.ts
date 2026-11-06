import { Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";

/**
 * Worker da Transactional Outbox.
 *
 * TODO(candidato):
 *  - a cada N ms, numa transação curta:
 *      select * from outbox_messages
 *       where published_at is null and next_attempt_at <= now()
 *       order by occurred_at
 *       limit 50
 *       for update skip locked;      -- permite vários publishers concorrentes sem duplicar trabalho
 *  - publicar cada evento (SNS/SQS ou fila de eventos), usando eventId como MessageDeduplicationId;
 *  - sucesso → published_at = now(); falha → OutboxMessage.scheduleRetry (attempts + backoff);
 *  - se o processo morrer depois do commit e antes de publicar, outra instância pega a linha
 *    (o lock some com a conexão). Publicação duplicada é segura: consumidores deduplicam por eventId.
 *  - métrica de outbox lag = now() - min(occurred_at) das pendentes.
 */
@Injectable()
export class OutboxPublisher implements OnModuleInit, OnApplicationShutdown {
  onModuleInit() {}
  onApplicationShutdown() {}
}
