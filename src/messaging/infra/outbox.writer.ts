import type { EntityManager } from "@mikro-orm/postgresql";
import type { IntegrationEvent } from "../domain/integration-event";
import { OutboxMessage } from "../domain/outbox-message";

/** Grava eventos na outbox usando a MESMA transação do caso de uso (em transacional). */
export async function enqueueOutbox(em: EntityManager, events: IntegrationEvent<unknown>[]): Promise<void> {
  for (const event of events) {
    const msg = OutboxMessage.enqueue(event);
    await em.execute(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       values (?, ?, ?, ?::jsonb, ?, 0, ?)`,
      [msg.id, msg.aggregateId, msg.eventType, JSON.stringify(msg.payload), msg.occurredAt, msg.occurredAt],
    );
  }
}
