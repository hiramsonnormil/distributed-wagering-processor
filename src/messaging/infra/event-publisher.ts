import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { EVENTS_QUEUE_NAME, queueUrl, sqsClient } from "./sqs.client";

/** Porta de publicação de eventos de integração (a outbox não conhece o broker). */
export interface EventPublisherPort {
  publish(message: { id: string; aggregateId: string; eventType: string; payload: unknown }): Promise<void>;
}

export const EVENT_PUBLISHER = Symbol("EVENT_PUBLISHER");

/**
 * Publica na fila FIFO de eventos. MessageDeduplicationId = eventId: se a mesma linha da outbox
 * for publicada duas vezes dentro da janela de 5 min do SQS, o broker descarta; fora da janela,
 * o consumidor deduplica por eventId (o broker é otimização, não garantia).
 */
export class SqsEventPublisher implements EventPublisherPort {
  async publish(message: { id: string; aggregateId: string; eventType: string; payload: unknown }): Promise<void> {
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: await queueUrl(EVENTS_QUEUE_NAME),
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: { eventType: { DataType: "String", StringValue: message.eventType } },
      }),
    );
  }
}
