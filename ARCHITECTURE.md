# Arquitetura e decisões

## Visão geral

```
HTTP (POST /wagering/transactions) ─┐
                                    ├─► SubmitWagerTransactionUseCase ─► WagerProcessor (regra financeira)
SQS (wager-transactions.fifo) ──────┘           │  uma transação SQL:
     WagerQueueConsumer                          │  lock wallet → inbox → transação → saldo/ledger → outbox
                                                 ▼
                         PostgreSQL (invariantes no schema)
                                                 │
            PendingReferenceWorker ◄─────────────┤  (PENDING_REFERENCE com backoff)
            OutboxPublisher ─────────────────────┴─► SQS wagering-events.fifo
```

- **Um único caso de uso** atende HTTP e SQS. A regra financeira fica em um lugar só (`WagerProcessor`),
  reaproveitada também pelo worker de `PENDING_REFERENCE`.
- Tudo que muda estado acontece em **uma transação SQL**: lock da wallet, inbox (quando vem da fila),
  registro da transação (idempotência), saldo, ledger, resultado e outbox.
  Nada é publicado e nenhuma mensagem recebe ack antes do commit.

### Camadas

| Pasta | Papel |
|---|---|
| `*/domain` | Classes com construtor privado + factories (`create`/`from`/`rehydrate`). Sem NestJS e sem ORM. `Money`, `Wallet`, `WalletLedgerEntry`, `WagerTransaction`, `InboxMessage`, `OutboxMessage`, eventos, `reference-policy` (regras puras de REFUND/ROLLBACK). |
| `*/application` | Casos de uso e workers: orquestram transação, lock, repositórios e outbox. |
| `*/infra` | Repositórios com SQL explícito, cliente SQS, publisher de eventos (porta `EventPublisherPort`). |
| `*/http` | Controllers finos: validam header, chamam o caso de uso, escolhem o status HTTP. |

## Dinheiro

- `Money` usa `decimal.js`, nunca `number`. Escala fixa de 2 casas na serialização.
- Entrada de contrato aceita só `^\d+(\.\d{1,2})?$`: rejeita `NaN`, `Infinity`, notação científica,
  string vazia, mais de 2 casas e negativos.
- Persistência em `numeric(20,2)` + `char(3)`; reidratação com `Money.fromPersistence`.
- Multi-moeda no modelo; operações entre moedas diferentes lançam `CurrencyMismatchError`.
  Moeda da operação ≠ moeda da wallet → `REJECTED / CURRENCY_MISMATCH`.

## ORM

MikroORM (preferencial), usado para `EntityManager.transactional()`, pool e **migrations versionadas e
reversíveis** (`bun run migration:up|down`). As operações financeiras usam SQL explícito
(`SELECT ... FOR UPDATE`, `INSERT ... ON CONFLICT`, `FOR UPDATE SKIP LOCKED`) para que a estratégia de
concorrência fique visível e revisável, em vez de escondida no Unit of Work. Trade-off: perde-se o
change tracking automático, mas cada escrita financeira é explícita e auditável. O domínio não depende de
decorators do ORM nem do NestJS.

## Concorrência

- Unidade de concorrência: `walletId`.
- **Lock pessimista por linha** (`SELECT ... FOR UPDATE` na wallet) no início da transação. Só a linha
  daquela wallet é travada: wallets diferentes seguem em paralelo. Não existe lock global.
- Defesa extra: o `UPDATE` do saldo é condicionado à `version` lida (`where version = ?`), e o banco tem
  `check (balance >= 0)` — mesmo um bug no código não consegue gerar saldo negativo.
- `lock_timeout` (padrão 5 s) evita espera infinita; estourou → `503` (HTTP) ou retry (SQS), métrica
  `lock_conflicts_total`.
- **Ordem de locks fixa** (wallet → transação) no caso de uso e no worker, para não haver deadlock.
- Por que pessimista e não optimistic: em wallet "quente" (muitas apostas da mesma rodada) o optimistic
  geraria uma tempestade de retries; o lock serializa só o necessário e a transação é curta.
- Testado com 3 processos reais (`test/integration/concurrency.test.ts`): cenário 100/80/80, a mesma
  aposta 50× em paralelo, hot wallet com 120 apostas, wallets distintas em paralelo e SIGKILL no meio da carga.

## Idempotência

- `Idempotency-Key` obrigatório (fonte da verdade); default `{providerId}:{externalTransactionId}`.
- Persistente: `unique (idempotency_key)` e `unique (provider_id, external_transaction_id)`.
  `INSERT ... ON CONFLICT DO NOTHING`: uma duplicata concorrente espera o commit da primeira no índice
  único e cai no caminho de replay.
- `payloadHash` = SHA-256 do JSON canônico (chaves ordenadas recursivamente, `undefined` removido) de:
  `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money,
  referenceExternalTransactionId`. Header e metadados de transporte não entram.
- Mesma key + mesmo hash → resultado original com o **saldo observado naquele momento**
  (`result_balance`) e `idempotentReplay: true`. Hash diferente → `409 IDEMPOTENCY_CONFLICT`.
- Nenhuma idempotência em memória.

## Regras de negócio e interpretações adotadas

| Operação | Efeito | Observação |
|---|---|---|
| `BET` | débito | sem saldo → `INSUFFICIENT_FUNDS` |
| `WIN` | crédito | referência opcional à BET da rodada: vinculada quando existe e bate; não bloqueia |
| `LOSS` | nenhum | `PROCESSED`, sem ledger, evento `WagerTransactionProcessed` |
| `REFUND` | crédito | só referencia `BET` |
| `ROLLBACK` | inverso da referência | referencia `BET`, `WIN` ou `REFUND` |

Interpretações (documentadas porque o enunciado deixa espaço):

1. **Uma referência aceita uma única reversão no total** (REFUND *ou* ROLLBACK), não uma por tipo. Sem
   isso, uma BET poderia receber REFUND e ROLLBACK e ser creditada duas vezes. Garantido por índice
   único parcial (`Migration20261109000000_single_reversal`) além do código. Um REFUND pode ser desfeito
   por um ROLLBACK que referencia o próprio REFUND.
2. Referência encontrada mas ainda `PENDING_REFERENCE` (ex.: ROLLBACK de um REFUND que também espera) →
   a reversão também espera.
3. Referência `REJECTED`/`FAILED` → `REFERENCE_NOT_PROCESSED` (terminal).
4. Referência de outro provider/player/wallet/moeda/rodada → `REFERENCE_MISMATCH`.
5. Reversão parcial fora de escopo: valor diferente → `AMOUNT_MISMATCH`.
6. Reversão que deixaria saldo negativo (ex.: ROLLBACK de WIN já gasto) → `REVERSAL_WOULD_OVERDRAW`,
   código diferente de `INSUFFICIENT_FUNDS`, e fica auditável como `REJECTED`.

### Referências fora de ordem (seção 7.1)

- Referência ausente → transação persistida como `PENDING_REFERENCE`, `202 Accepted`, evento
  `WagerTransactionPendingReference`.
- `PendingReferenceWorker` (todas as instâncias) busca as vencidas; para cada uma trava a wallet e depois
  a linha com `FOR UPDATE SKIP LOCKED` (duas instâncias nunca processam a mesma).
- Backoff exponencial 1 s, 2 s, 4 s… teto 60 s. **Limite: 8 tentativas (~4 min)**, configurável
  (`PENDING_REFERENCE_MAX_ATTEMPTS`). Justificativa: provedores costumam entregar a BET em segundos;
  minutos cobrem reentrega da fila e indisponibilidade curta, sem deixar o provedor sem resposta final
  por muito tempo.
- Esgotou → `REJECTED / REFERENCE_NOT_FOUND` + `WagerTransactionRejected` na outbox.
- Quando a referência chega, as dependentes são "acordadas" (`next_attempt_at = now()`), então na prática
  a reversão é aplicada em menos de um segundo.

## Códigos de falha

| `failureCode` | Quando | O provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET sem saldo | desistir (não reenviar igual) |
| `REVERSAL_WOULD_OVERDRAW` | reversão deixaria saldo negativo | tratar manualmente |
| `CURRENCY_MISMATCH` | moeda ≠ wallet | corrigir payload |
| `WALLET_OWNERSHIP_MISMATCH` | playerId não é dono da wallet | corrigir payload |
| `REFERENCE_NOT_FOUND` | referência não chegou no prazo | reenviar com nova id após enviar a referência |
| `REFERENCE_MISMATCH` | referência de outro contexto | corrigir payload |
| `REFERENCE_INVALID_KIND` | ex.: REFUND de WIN | corrigir payload |
| `REFERENCE_NOT_PROCESSED` | referência rejeitada | desistir |
| `REFERENCE_ALREADY_REVERSED` | já revertida | desistir (já está feito) |
| `AMOUNT_MISMATCH` | valor ≠ referência | corrigir payload |

## Status HTTP

| Situação | Status | Pode reenviar? |
|---|---|---|
| Payload inválido / header ausente / cursor inválido | 400 | não, corrigir |
| Wallet/transação não encontrada | 404 | não |
| Conflito de idempotência / wallet duplicada | 409 | não |
| Rejeição por regra de negócio (corpo com `failureCode`) | 422 | não |
| Aceito, aguardando referência | 202 | sim (replay devolve o estado atual) |
| Processada (nova) / replay | 201 / 200 | — |
| Falha transitória (banco fora, lock timeout) + `Retry-After` | 503 | sim, mesma key |

## Mensageria

### Consumidor SQS (`wager-transactions.fifo`)

- Long polling, mensagens do lote em ordem (FIFO por `MessageGroupId`, sugerido = `walletId`).
- Inbox persistente: `INSERT` em `inbox_messages (consumer_name, message_id)` **na mesma transação** do
  caso de uso. Redelivery → só replay + ack, sem efeito duplicado.
- **Ack só depois do commit.** Morreu depois do commit e antes do ack → a mensagem volta após o
  visibility timeout e a inbox a reconhece.
- Classificação de erro: **negócio** (regra, payload, conflito) → terminal, ack; **transitório**
  (lock timeout, deadlock, conexão) → sem ack, visibilidade com backoff 2^n s; **permanente** (JSON/envelope
  inválido, violação de constraint inesperada) → DLQ. Transitório que passa de `SQS_MAX_RECEIVES` (5) → DLQ.
  O redrive policy da fila (maxReceiveCount 5) fica como rede de segurança.
- `SIGTERM`: para de receber (aborta o long polling), termina a mensagem em andamento e devolve as que
  ainda não começaram com visibilidade 0. Workers usam `beforeApplicationShutdown`, então terminam antes
  do pool do banco fechar.

### Transactional Outbox

- Eventos gravados em `outbox_messages` na transação do caso de uso.
- `OutboxPublisher` roda em todas as instâncias: `SELECT ... FOR UPDATE SKIP LOCKED` em lotes — vários
  publishers concorrentes nunca pegam a mesma linha.
- Sucesso → `published_at`; falha → `attempts + 1` e backoff exponencial com jitter.
- Crash depois do commit e antes de publicar → outra instância publica. Crash depois de publicar e antes
  de marcar → republica (at-least-once). Seguro porque `MessageDeduplicationId = eventId` e o consumidor
  deve deduplicar por `eventId`.
- Publicação atrás de uma porta (`EventPublisherPort`); implementação SQS na fila `wagering-events.fifo`.
- Eventos: `WagerTransactionProcessed` (inclusive LOSS), `WagerTransactionRejected`,
  `WalletBalanceChanged` (só quando o saldo muda), `WagerTransactionPendingReference`. Envelope abstrato
  `IntegrationEvent<T>` com `eventType` e `version` no tipo; `data` sempre JSON estável (`MoneyProps`).

## Invariantes no banco

| Garantia | Onde |
|---|---|
| Uma wallet por `playerId + currency` | `unique (player_id, currency)` |
| Saldo nunca negativo | `check (balance >= 0)` e `check` nos saldos do ledger |
| Idempotência | `unique (idempotency_key)`, `unique (provider_id, external_transaction_id)` |
| REFUND/ROLLBACK exigem referência | `check` em `wager_transactions` |
| `failure_code` presente só em REJECTED/FAILED | `check` |
| Uma reversão por referência | índice único parcial `(reference_transaction_id)` em REFUND/ROLLBACK PROCESSED |
| Um lançamento por transação e wallet | `unique (transaction_id, wallet_id)` |
| Lançamento balanceado | `check (balance_after = balance_before ± amount)` |
| Ledger imutável | trigger que bloqueia `UPDATE`/`DELETE` |
| Inbox | PK `(consumer_name, message_id)` |

## Consultas

- `GET /wallets/:id/ledger?cursor=&limit=` — cursor opaco `base64url(created_at|id)`, ordem
  `(created_at, id)`; o `created_at` vem do próprio Postgres (`::text`) para não perder microssegundos.
  Novos lançamentos não deslocam páginas já lidas.
- `POST /wallets/:id/reconciliation` — saldo materializado vs. Σ CREDIT − Σ DEBIT numa única query
  (mesmo snapshot). Divergência **não é corrigida**: log de erro, métrica
  `reconciliation_mismatches_total` e `consistent: false` na resposta.

## Observabilidade

- Logs JSON com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`; sem payload
  financeiro completo.
- `GET /metrics` (formato Prometheus, por instância): `wager_transactions_total{status,kind}`,
  `duplicates_detected_total{source}`, `idempotency_conflicts_total`, `sqs_retries_total`,
  `sqs_dlq_total`, `pending_reference_retries_total`, `lock_conflicts_total`,
  `outbox_lag_seconds`, `outbox_pending_messages`, `outbox_publish_retries_total`,
  `reconciliation_mismatches_total`, histogramas `wager_processing_ms`, `wallet_lock_wait_ms`,
  `outbox_publish_ms`.
- `GET /health/live` (processo) e `GET /health/ready` (Postgres + SQS), sem autenticação.

## Autenticação

Não vale pontos (seção 2); **não implementada** por decisão de timebox. Ponto de extensão explícito:
`ProviderAuthGuard` (no-op) aplicado aos controllers. Desenho proposto: Keycloak no Docker Compose
emitindo tokens OIDC via `client_credentials`, um client por provedor; o guard valida o JWT pelo JWKS e
confere que o provedor do token é o `providerId` do payload. Health checks ficam abertos; mensagens da
fila são canal interno confiável, mas o `providerId` delas passa pelas mesmas validações de domínio.

## Testes

- **Unidade** (`test/unit`): Money (escala, entradas inválidas), Wallet (invariantes, version),
  WagerTransaction (transições), regras de REFUND/ROLLBACK (`reference-policy`), conflito de moeda,
  payload hash/conflito, classificação de erros do consumidor.
- **Integração** (`test/integration`, PostgreSQL e SQS reais, nada mockado):
  - `schema`: migrations e constraints (CHECK, UNIQUE, trigger de imutabilidade, reversão única);
  - `concurrency`: 3 processos reais — 100/80/80, 50× a mesma aposta, hot wallet, wallets distintas,
    conflito de payload, REFUND/ROLLBACK, LOSS, ROLLBACK antes da BET, cursor e reconciliação,
    SIGKILL no meio da carga + reenvio, invariante final;
  - `messaging`: worker morto após commit e antes do ack, consumidor real com mensagem duplicada,
    DLQ para mensagem malformada, retry transitório até DLQ, atomicidade wallet/ledger/inbox/outbox,
    dois publishers na mesma outbox, crash antes de publicar, falha de publish com backoff, esgotamento
    de `PENDING_REFERENCE`.
- Todo teste de integração termina com `wallet.balance == saldo reconstruído pelo ledger`.

## Limitações conhecidas e próximos passos

- Métricas são em memória por instância (em produção: prom-client/OpenTelemetry e agregação).
- Teste de carga (`test:load`) não foi feito.
- A fila de eventos é FIFO por `aggregateId`; um consumidor de eventos real ainda precisaria da própria
  inbox por `eventId`.
- Nos testes locais sem Docker, o SQS foi emulado com `moto_server` (mesma API); no Compose, LocalStack.
- Rodar migrations uma vez antes das réplicas (serviço `migrate` no Compose; `RUN_MIGRATIONS=false` nas apps).
