import { Module } from "@nestjs/common";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health/health.controller";
import { OutboxPublisher } from "./messaging/infra/outbox.publisher";
import { WagerQueueConsumer } from "./messaging/infra/wager-queue.consumer";
import { PendingReferenceWorker } from "./wagering/application/pending-reference.worker";
import { SubmitWagerTransactionUseCase } from "./wagering/application/submit-wager-transaction.use-case";
import { WageringController } from "./wagering/http/wagering.controller";
import { CreateWalletUseCase } from "./wallet/application/create-wallet.use-case";
import { WalletController } from "./wallet/http/wallet.controller";

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController, WalletController, WageringController],
  providers: [
    CreateWalletUseCase,
    SubmitWagerTransactionUseCase,
    WagerQueueConsumer,
    OutboxPublisher,
    PendingReferenceWorker,
  ],
})
export class AppModule {}
