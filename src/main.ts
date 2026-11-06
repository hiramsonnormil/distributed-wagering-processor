import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { AppModule } from "./app.module";
import { AppExceptionFilter } from "./shared/infra/http-exception.filter";
import { log } from "./shared/infra/logger";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });
  app.useGlobalFilters(new AppExceptionFilter());
  app.enableShutdownHooks(); // SIGTERM → onApplicationShutdown dos workers

  if (process.env.RUN_MIGRATIONS !== "false") {
    await app.get(MikroORM).getMigrator().up();
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  log.info("app started", { port });
}

bootstrap();
