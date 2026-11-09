import { Injectable, type BeforeApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import { DomainError, InvalidMoneyError } from "../../shared/domain/errors";
import { log } from "../../shared/infra/logger";
import { metrics } from "../../shared/infra/metrics";
import { SubmitWagerTransactionUseCase, type SubmitWagerInput } from "../../wagering/application/submit-wager-transaction.use-case";
import { DLQ_NAME, QUEUE_NAME, queueUrl, sqsClient } from "./sqs.client";

export const CONSUMER_NAME = "wager-transactions-consumer";

/** Classificação de erro → o que fazer com a mensagem. */
export type ErrorClass = "BUSINESS" | "TRANSIENT" | "PERMANENT";

interface WagerMessage {
  messageId: string;
  type: string;
  occurredAt?: string;
  data: Omit<SubmitWagerInput, "correlationId"> & { correlationId?: string };
}

/** Postgres: lock_timeout, deadlock, serialization, conexão/indisponibilidade. */
const TRANSIENT_PG_CODES = new Set(["55P03", "40P01", "40001", "57P01", "57P03", "53300", "08000", "08003", "08006"]);

export class PermanentMessageError extends Error {}

export function classifyError(err: unknown): ErrorClass {
  if (err instanceof PermanentMessageError) return "PERMANENT";
  // Regra de negócio / payload inválido / conflito de idempotência: reenviar não muda nada.
  if (err instanceof DomainError || err instanceof InvalidMoneyError) return "BUSINESS";
  const code = (err as { code?: string })?.code;
  if (code && TRANSIENT_PG_CODES.has(code)) return "TRANSIENT";
  // Violação de constraint inesperada = bug ou dado corrompido: não adianta retry infinito.
  if (code && /^23/.test(code)) return "PERMANENT";
  return "TRANSIENT"; // rede, timeout, banco fora: tenta de novo com backoff
}

/**
 * Consumidor de wager-transactions.fifo.
 *
 * - Long polling; mensagens de um lote processadas em ordem (FIFO por MessageGroupId = walletId).
 * - Usa o MESMO caso de uso do HTTP, com inbox (consumer_name, message_id) na mesma transação.
 * - ack (DeleteMessage) SOMENTE depois do commit.
 * - BUSINESS → terminal, ack. TRANSIENT → sem ack, visibilidade com backoff exponencial.
 *   PERMANENT (ou TRANSIENT que esgotou MAX_RECEIVES) → copia para a DLQ e dá ack.
 *   O redrive policy da fila (maxReceiveCount) fica como rede de segurança.
 * - SIGTERM: para de receber; termina a mensagem em andamento; as que ainda não começaram
 *   voltam para a fila na hora (visibilidade 0).
 * - Worker que morre depois do commit e antes do ack: a mensagem reaparece após o
 *   VisibilityTimeout; a inbox detecta a redelivery e só faz o ack, sem duplicar efeito.
 */
@Injectable()
export class WagerQueueConsumer implements OnModuleInit, BeforeApplicationShutdown {
  private running = false;
  private loop?: Promise<void>;
  private abort?: AbortController;
  private readonly maxReceives = Number(process.env.SQS_MAX_RECEIVES ?? 5);
  private readonly waitSeconds = Number(process.env.SQS_WAIT_SECONDS ?? 20);

  constructor(private readonly submit: SubmitWagerTransactionUseCase) {}

  onModuleInit() {
    if (process.env.SQS_CONSUMER_ENABLED !== "true") return;
    this.running = true;
    this.loop = this.pollLoop();
  }

  async beforeApplicationShutdown() {
    this.running = false;
    this.abort?.abort(); // interrompe o long polling
    await this.loop;
  }

  private async pollLoop() {
    while (this.running) {
      try {
        this.abort = new AbortController();
        const url = await queueUrl(QUEUE_NAME);
        const res = await sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: url,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.waitSeconds,
            MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
          }),
          { abortSignal: this.abort.signal },
        );
        const messages = res.Messages ?? [];
        for (let i = 0; i < messages.length; i++) {
          if (!this.running) {
            // Shutdown: devolve imediatamente o que ainda não começou.
            await this.releaseAll(url, messages.slice(i));
            break;
          }
          await this.handle(url, messages[i]!);
        }
      } catch (err) {
        if (!this.running) break;
        log.error("sqs receive failed", { error: (err as Error).message });
        await Bun.sleep(1000);
      }
    }
  }

  /** Processa UMA mensagem. Público para testes de integração determinísticos. */
  async handle(url: string, message: Message): Promise<ErrorClass | "OK"> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    let parsed: WagerMessage | undefined;
    try {
      parsed = parseMessage(message.Body);
      const result = await this.submit.execute(
        { ...parsed.data, correlationId: parsed.data.correlationId ?? parsed.messageId },
        { consumerName: CONSUMER_NAME, messageId: parsed.messageId },
      );
      await this.ack(url, message);
      log.info("sqs message processed", {
        messageId: parsed.messageId,
        transactionId: result.transactionId,
        walletId: parsed.data.walletId,
        providerId: parsed.data.providerId,
        status: result.status,
        idempotentReplay: result.idempotentReplay,
      });
      return "OK";
    } catch (err) {
      const kind = classifyError(err);
      const fields = {
        messageId: parsed?.messageId ?? message.MessageId,
        walletId: parsed?.data?.walletId,
        providerId: parsed?.data?.providerId,
        error: (err as Error).message,
        errorClass: kind,
        receiveCount,
      };
      if (kind === "BUSINESS") {
        // Terminal: o resultado (ex.: conflito, payload inválido) não muda com retry.
        metrics.inc("sqs_messages_total", { result: "business_error" });
        log.warn("sqs business error, acking", fields);
        await this.ack(url, message);
        return kind;
      }
      if (kind === "PERMANENT" || receiveCount >= this.maxReceives) {
        log.error("sqs message sent to DLQ", fields);
        await this.toDlq(message, (err as Error).message);
        await this.ack(url, message);
        return "PERMANENT";
      }
      const delay = Math.min(300, 2 ** receiveCount); // 2s, 4s, 8s, 16s...
      metrics.inc("sqs_retries_total");
      log.warn("sqs transient error, will retry", { ...fields, retryInSeconds: delay });
      await sqsClient
        .send(new ChangeMessageVisibilityCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: delay }))
        .catch(() => undefined);
      return kind;
    }
  }

  private async ack(url: string, message: Message) {
    await sqsClient.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }));
  }

  private async toDlq(message: Message, reason: string) {
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: await queueUrl(DLQ_NAME),
        MessageBody: message.Body ?? "",
        MessageGroupId: message.Attributes?.MessageGroupId ?? "dlq",
        MessageDeduplicationId: (message.MessageId ?? crypto.randomUUID()).slice(0, 128),
        MessageAttributes: { reason: { DataType: "String", StringValue: reason.slice(0, 250) || "unknown" } },
      }),
    );
    metrics.inc("sqs_dlq_total");
  }

  private async releaseAll(url: string, messages: Message[]) {
    await Promise.all(
      messages.map((m) =>
        sqsClient
          .send(new ChangeMessageVisibilityCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle, VisibilityTimeout: 0 }))
          .catch(() => undefined),
      ),
    );
  }
}

function parseMessage(body: string | undefined): WagerMessage {
  let json: unknown;
  try {
    json = JSON.parse(body ?? "");
  } catch {
    throw new PermanentMessageError("Mensagem não é JSON válido");
  }
  const m = json as Partial<WagerMessage>;
  if (!m || typeof m.messageId !== "string" || !m.messageId || m.type !== "WagerTransactionRequested" || !m.data) {
    throw new PermanentMessageError("Envelope inválido (messageId/type/data)");
  }
  if (typeof m.data.idempotencyKey !== "string" || !m.data.idempotencyKey) {
    throw new PermanentMessageError("data.idempotencyKey é obrigatório");
  }
  return m as WagerMessage;
}

export const _test = { parseMessage, QUEUE_NAME };
