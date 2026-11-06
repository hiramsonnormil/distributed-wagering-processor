# Arquitetura e decisões

## Visão geral

Um único caso de uso (`SubmitWagerTransactionUseCase`) atende a API HTTP e o consumidor SQS.
Ele roda tudo em **uma transação SQL**: lock da wallet, registro da transação (idempotência),
regra de negócio no domínio, saldo, ledger, inbox (quando vier da fila) e outbox.
Nada é publicado e nenhuma mensagem recebe ack antes do commit.

## Dinheiro

- `Money` usa `decimal.js`, nunca `number`. Escala fixa de 2 casas na serialização.
- Entrada de contrato aceita só `^\d+(\.\d{1,2})?$`: rejeita `NaN`, `Infinity`, notação científica,
  string vazia, mais de 2 casas e negativos.
- Persistência em `numeric(20,2)` + `char(3)` para a moeda; reidratação com `Money.fromPersistence`.
- O modelo é multi-moeda; operações entre moedas diferentes lançam `CurrencyMismatchError`.

## ORM

MikroORM (preferencial no desafio), usado para `EntityManager.transactional()`, pool e **migrations
versionadas e reversíveis**. As operações financeiras usam SQL explícito (`SELECT ... FOR UPDATE`,
`INSERT ... ON CONFLICT`) para que a estratégia de concorrência fique visível e revisável,
em vez de escondida atrás do Unit of Work. O domínio não depende de decorators do ORM nem do NestJS.

## Concorrência

- Unidade de concorrência: `walletId`.
- Estratégia: **lock pessimista por linha** (`SELECT ... FOR UPDATE` na wallet) dentro da transação.
  Apenas a linha daquela wallet é bloqueada, então wallets diferentes seguem em paralelo.
  Não existe lock global.
- Defesa extra: o `UPDATE` do saldo é condicionado à `version` lida (`where version = ?`).
- Por que pessimista: wallets "quentes" (muitas apostas na mesma rodada) gerariam muitos retries
  com optimistic locking; o lock serializa só o necessário e o tempo de transação é curto.
- Cenário obrigatório (saldo 100, duas apostas de 80 em instâncias diferentes): verificado
  manualmente com 3 instâncias → uma `PROCESSED` (201), outra `REJECTED`/`INSUFFICIENT_FUNDS` (422),
  saldo 20.00, um único débito no ledger.

## Idempotência

- `Idempotency-Key` obrigatório; default `{providerId}:{externalTransactionId}`.
- Persistente: `unique (idempotency_key)` e `unique (provider_id, external_transaction_id)`.
  O `INSERT ... ON CONFLICT DO NOTHING` faz uma requisição concorrente duplicada esperar o commit
  da primeira e cair no caminho de replay.
- `payloadHash` = SHA-256 do JSON canônico (chaves ordenadas recursivamente, `undefined` removido) dos
  campos de negócio: `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind,
  money, referenceExternalTransactionId`. Header e metadados de transporte não entram.
- Mesma key + mesmo hash → resposta original (incluindo o saldo observado, guardado em
  `result_balance`) com `idempotentReplay: true`. Hash diferente → `409 IDEMPOTENCY_CONFLICT`.
- Verificado: a mesma aposta 50 vezes em paralelo em 3 instâncias → 1×201 e 49×200, um único débito.

## Invariantes no banco

| Garantia | Onde |
|---|---|
| Uma wallet por `playerId + currency` | `unique (player_id, currency)` |
| Saldo nunca negativo | `check (balance >= 0)` |
| Idempotência | `unique (idempotency_key)`, `unique (provider_id, external_transaction_id)` |
| REFUND/ROLLBACK exigem referência | `check` em `wager_transactions` |
| Reversão única por tipo | índice único parcial `(reference_transaction_id, kind)` |
| Um lançamento por transação e wallet | `unique (transaction_id, wallet_id)` |
| Lançamento balanceado | `check (balance_after = balance_before ± amount)` |
| Ledger imutável | trigger que bloqueia `UPDATE`/`DELETE` |
| Inbox | PK `(consumer_name, message_id)` |

## Status HTTP

| Situação | Status |
|---|---|
| Payload inválido / header ausente | 400 |
| Wallet/transação não encontrada | 404 |
| Conflito de idempotência / wallet duplicada | 409 |
| Rejeição por regra de negócio (corpo com `failureCode`) | 422 |
| Aceito, aguardando referência (`PENDING_REFERENCE`) | 202 |
| Processada (nova) / replay | 201 / 200 |
| Falha transitória de infraestrutura (pode reenviar) | 503 |

## Códigos de falha

Ver `src/wagering/domain/failure-code.ts`. `INSUFFICIENT_FUNDS` (aposta sem saldo) é distinto de
`REVERSAL_WOULD_OVERDRAW` (reversão que deixaria saldo negativo).

## Transições de `WagerTransaction`

`PENDING → PENDING_REFERENCE | PROCESSED | REJECTED | FAILED`
`PENDING_REFERENCE → PENDING_REFERENCE | PROCESSED | REJECTED | FAILED`
`PROCESSED`, `REJECTED`, `FAILED` são terminais; transicioná-los lança `InvalidTransactionStateError`.

## Autenticação

Não vale pontos (seção 2). Decisão atual: não implementada. Desenho proposto: Keycloak via Docker
Compose emitindo tokens OIDC com `client_credentials` por provedor; um `ProviderAuthGuard` valida o JWT
e confere que o `providerId` do token é o mesmo do payload. Health checks ficam abertos; mensagens
da fila são canal interno confiável.

## Status do desenvolvimento

- [x] Domínio: `Money`, `Wallet`, `WalletLedgerEntry`, `WagerTransaction`, `InboxMessage`, `OutboxMessage`, eventos
- [x] Migration com constraints, índices e trigger de imutabilidade
- [x] `POST /wallets` com `OPENING` + ledger + outbox na mesma transação
- [x] `POST /wagering/transactions` para BET, WIN e LOSS com idempotência persistente e lock por wallet
- [x] Health checks, logs JSON, métricas básicas
- [x] Testes de unidade do domínio
- [ ] REFUND/ROLLBACK com resolução de referência e `PENDING_REFERENCE`
- [ ] Worker de `PENDING_REFERENCE` (backoff + limite)
- [ ] Consumidor SQS com inbox, ack após commit, retry/DLQ e shutdown gracioso
- [ ] Publisher da outbox (`FOR UPDATE SKIP LOCKED`, backoff)
- [ ] Ledger paginado por cursor e reconciliação
- [ ] Testes de integração e concorrência com Postgres/LocalStack reais
- [ ] Métricas completas (retries, DLQ, conflitos de lock, outbox lag, latência)

## Limitações conhecidas

- Migrations rodam no boot (`RUN_MIGRATIONS`); com várias instâncias, rodar uma vez antes
  (`bun run migration:up`) e subir as réplicas com `RUN_MIGRATIONS=false`.
