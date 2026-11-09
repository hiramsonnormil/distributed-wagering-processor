import type { EntityManager } from "@mikro-orm/postgresql";

/**
 * Inbox persistente: deduplicação por (consumer_name, message_id) — PK composta.
 * Sempre usado dentro da transação do caso de uso, junto com saldo, ledger e outbox.
 */
export class InboxRepository {
  /**
   * true = primeira entrega desta mensagem. false = já registrada (redelivery).
   * Uma entrega concorrente da mesma mensagem espera o commit da primeira no índice da PK.
   */
  async tryReceive(em: EntityManager, consumerName: string, messageId: string, payloadHash: string, at: Date): Promise<boolean> {
    const rows = await em.execute<{ message_id: string }[]>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
       values (?, ?, ?, ?)
       on conflict do nothing
       returning message_id`,
      [consumerName, messageId, payloadHash, at],
    );
    return rows.length === 1;
  }

  async markProcessed(em: EntityManager, consumerName: string, messageId: string, at: Date): Promise<void> {
    await em.execute(
      `update inbox_messages set processed_at = coalesce(processed_at, ?) where consumer_name = ? and message_id = ?`,
      [at, consumerName, messageId],
    );
  }
}
