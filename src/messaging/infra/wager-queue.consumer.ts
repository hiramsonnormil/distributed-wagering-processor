import { Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { SubmitWagerTransactionUseCase } from "../../wagering/application/submit-wager-transaction.use-case";

/**
 * Consumidor de wager-transactions.fifo.
 *
 * TODO(candidato):
 *  - long polling (ReceiveMessage, WaitTimeSeconds=20);
 *  - na MESMA transação do caso de uso: INSERT em inbox_messages (consumer_name, message_id)
 *    ON CONFLICT DO NOTHING; se já processada → só ack;
 *    (sugestão: passar um `inbox` opcional para SubmitWagerTransactionUseCase.execute)
 *  - ack (DeleteMessage) SOMENTE depois do commit;
 *  - erro de negócio → terminal, ack; erro transitório → não ack (volta pela visibilidade,
 *    ChangeMessageVisibility com backoff); erro permanente → deixa o redrive levar à DLQ;
 *  - SIGTERM: parar de receber, terminar as mensagens em andamento ou devolver a visibilidade (=0).
 */
@Injectable()
export class WagerQueueConsumer implements OnModuleInit, OnApplicationShutdown {
  private running = false;

  constructor(private readonly submit: SubmitWagerTransactionUseCase) {}

  onModuleInit() {
    this.running = process.env.SQS_CONSUMER_ENABLED === "true";
    // TODO(candidato): iniciar o loop de polling quando habilitado.
  }

  async onApplicationShutdown() {
    this.running = false;
  }
}
