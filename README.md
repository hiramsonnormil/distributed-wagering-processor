# Distributed Wagering Processor

Desafio técnico da Jungle Gaming: serviço financeiro distribuído que processa transações de apostas
(`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de vários provedores, por HTTP e por SQS.

Stack: **Bun 1.x**, **TypeScript estrito**, **NestJS**, **PostgreSQL**, **MikroORM** (migrations e transações),
**SQS via LocalStack**, **Docker Compose**.

## Como rodar

```bash
cp .env.example .env
docker compose up -d postgres localstack   # banco + filas (wager-transactions.fifo e DLQ)
bun install
bun run start                              # aplica as migrations e sobe na porta 3000
```

Três instâncias da aplicação (prova de correção com múltiplos processos):

```bash
docker compose up --build --scale app=3
```

## Testes

```bash
bun run test:unit          # domínio: Money, Wallet, WagerTransaction, payload hash
bun run test:integration   # PostgreSQL e LocalStack reais (em construção)
bun run typecheck
```

## Exemplos

```bash
# Criar wallet
curl -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

# Aposta
curl -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"80.00","currency":"BRL"}}'
```

## Endpoints

| Método | Rota | Status |
|---|---|---|
| POST | `/wallets` | ✅ |
| GET | `/wallets/:walletId` | ✅ |
| GET | `/wallets/:walletId/ledger?cursor=&limit=` | 🚧 |
| POST | `/wallets/:walletId/reconciliation` | 🚧 |
| POST | `/wagering/transactions` | ✅ BET/WIN/LOSS · 🚧 REFUND/ROLLBACK |
| GET | `/wagering/transactions/:transactionId` | ✅ |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | ✅ |
| GET | `/health/live`, `/health/ready` | ✅ |
| GET | `/metrics` | ✅ (parcial) |

## Estrutura

```
src/
  shared/domain      Money, erros de domínio
  wallet/            Wallet (aggregate root), WalletLedgerEntry, repositório, controller
  wagering/          WagerTransaction, FailureCode, payload hash, caso de uso único (HTTP + SQS)
  messaging/         IntegrationEvent + eventos, Inbox/Outbox, consumidor SQS, publisher da outbox
  database/          config do MikroORM e migrations (constraints e trigger do ledger)
  health/            liveness, readiness e métricas
test/unit            testes de domínio
```

Decisões, trade-offs e limitações: ver [ARCHITECTURE.md](./ARCHITECTURE.md).
