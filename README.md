# Distributed Wagering Processor

Desafio técnico da Jungle Gaming: serviço financeiro distribuído que processa transações de apostas
(`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de vários provedores, por HTTP e por SQS, correto com
mensagens duplicadas, fora de ordem e processadas em paralelo por várias instâncias.

Stack: **Bun 1.x**, **TypeScript estrito**, **NestJS**, **PostgreSQL**, **MikroORM** (transações e
migrations reversíveis), **SQS via LocalStack**, **Docker Compose**.

Decisões, trade-offs e limitações: [ARCHITECTURE.md](./ARCHITECTURE.md).

## Como rodar

Tudo com Docker (Postgres, LocalStack com as filas, migrations uma vez e **3 instâncias** nas portas 3000–3002):

```bash
docker compose up --build
```

Local, uma instância:

```bash
cp .env.example .env
docker compose up -d postgres localstack   # banco + filas (wager-transactions.fifo, DLQ e wagering-events.fifo)
bun install
bun run migration:up
bun run start                              # porta 3000
```

## Testes

```bash
bun run test:unit           # domínio e regras (sem infraestrutura)
bun run test:integration    # PostgreSQL + LocalStack REAIS: suba antes `docker compose up -d postgres localstack`
bun run typecheck
```

Os testes de integração usam o banco `wagering_test` (`TEST_DATABASE_URL`) e sobem **3 processos reais**
da aplicação (o banco de teste é criado pelo init do Postgres no Compose).

## Exemplos

```bash
# Criar wallet
curl -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

# Aposta
curl -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"80.00","currency":"BRL"}}'

# Refund da aposta
curl -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:refund-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"refund-123","referenceExternalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id>","roundId":"round-987","gameId":"fortune-chimp","kind":"REFUND","money":{"amount":"80.00","currency":"BRL"}}'

# Mensagem na fila
awslocal sqs send-message --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","data":{...,"idempotencyKey":"provider-a:transaction-123"}}'
```

## Endpoints

| Método | Rota | |
|---|---|---|
| POST | `/wallets` | cria wallet (+ `OPENING` e ledger na mesma transação) |
| GET | `/wallets/:walletId` | saldo e version |
| GET | `/wallets/:walletId/ledger?cursor=&limit=` | ledger paginado por cursor opaco |
| POST | `/wallets/:walletId/reconciliation` | saldo materializado × ledger |
| POST | `/wagering/transactions` | BET, WIN, LOSS, REFUND, ROLLBACK (header `Idempotency-Key`) |
| GET | `/wagering/transactions/:transactionId` | |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | |
| GET | `/health/live`, `/health/ready` | sem autenticação |
| GET | `/metrics` | formato Prometheus |

## Estrutura

```
src/
  shared/           Money, erros, logger JSON, métricas, filtro HTTP, ponto de extensão de auth
  wallet/           Wallet (aggregate root), WalletLedgerEntry, criação, ledger paginado, reconciliação
  wagering/
    domain/         WagerTransaction, FailureCode, payload hash, reference-policy (REFUND/ROLLBACK)
    application/    SubmitWagerTransactionUseCase (HTTP + SQS), WagerProcessor, PendingReferenceWorker
    infra/ http/    repositório SQL e controller
  messaging/        IntegrationEvent + eventos, Inbox/Outbox, consumidor SQS, publisher da outbox
  database/         config do MikroORM, migrations (constraints, índices e trigger do ledger), migrate.ts
  health/           liveness, readiness e métricas
test/unit           domínio e regras
test/integration    schema, concorrência com 3 instâncias, mensageria (inbox, outbox, retry, DLQ, crash)
```

## Variáveis de ambiente

Ver `.env.example`. Principais: `SQS_CONSUMER_ENABLED`, `OUTBOX_PUBLISHER_ENABLED`,
`PENDING_REFERENCE_MAX_ATTEMPTS` (8), `SQS_MAX_RECEIVES` (5), `LOCK_TIMEOUT_MS` (5000), `RUN_MIGRATIONS`.
