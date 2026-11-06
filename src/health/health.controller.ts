import { Controller, Get, Res } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { GetQueueUrlCommand } from "@aws-sdk/client-sqs";
import type { Response } from "express";
import { metrics } from "../shared/infra/metrics";
import { sqsClient, QUEUE_NAME } from "../messaging/infra/sqs.client";

/** Health checks abertos (sem autenticação). */
@Controller()
export class HealthController {
  constructor(private readonly em: EntityManager) {}

  @Get("health/live")
  live() {
    return { status: "ok" };
  }

  @Get("health/ready")
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks = { postgres: false, sqs: false };
    try {
      await this.em.fork().execute("select 1");
      checks.postgres = true;
    } catch {}
    try {
      await sqsClient.send(new GetQueueUrlCommand({ QueueName: QUEUE_NAME }));
      checks.sqs = true;
    } catch {}
    const ok = checks.postgres && checks.sqs;
    res.status(ok ? 200 : 503);
    return { status: ok ? "ready" : "not_ready", checks };
  }

  @Get("metrics")
  metrics(@Res() res: Response) {
    res.type("text/plain").send(metrics.render());
  }
}
