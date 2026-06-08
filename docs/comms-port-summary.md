# Comms Port — Summary

Outbound messaging (email + WhatsApp OTP + transactional email) extracted from
`bb-platform` into a separate worker repo `bb-comms`, decoupled via RabbitMQ.

- Decision + rationale: [ADR-0002](adr/0002-email-otp-service-boundary.md)
- Scope inventory + producer checklist: [email-scope.md](email-scope.md)
- Status tracker: [rewrite-progress.md](rewrite-progress.md) (§ comms)

## Two repos

| Repo | Role | Path |
|---|---|---|
| `bb-platform` | **producer** — enqueues to the outbox, never sends | `/home/cold/code/werk/bb/bb-backend-new` |
| `bb-comms` | **worker** — renders + delivers | `/home/cold/code/werk/bb/bb-comms` (separate git repo, remote `devtribelio/bb-comms` TBD) |

## Architecture

```
bb-platform (producer)                          bb-comms (worker, separate repo)
──────────────────────                          ────────────────────────────────
otp.service / domain event
  → enqueue NotificationOutbox row [1 txn]      consume {v,messageId,type,channel,priority,refId?,payload?}
     (transactional outbox, no dual-write race)   → OTP: code inline from payload (otp_codes holds only the hash)
  → comms-relay daemon polls PENDING              → transactional: READ Postgres by refId (legacy Engine pattern)
  → publish RabbitMQ                              → MJML+Handlebars render → SES / Qontak send
        │                                         → write comms_delivery + comms_idempotency
        ▼                                         → ack / nack→DLQ
   RabbitMQ (vhost comms, direct exchange,
   queues urgent|normal + DLX/DLQ)  ◄──── contract = versioned message body + PG read-schema
        │
   shared Postgres (bb-comms READS business tables + WRITES comms_*)
```

### Key principles

1. **Transactional outbox** — domain mutation + outbox row commit in one Prisma
   transaction; the relay publishes PENDING rows → at-least-once, no dual-write race.
2. **Message = lightweight trigger** `{type, refId}`; the worker reads PG for data
   (legacy `TBEmail_Engine` pattern). **Exception: OTP** — plaintext code rides inline
   in the payload because `otp_codes` stores only the bcrypt hash.
3. **Idempotency** — `comms_idempotency` (check-before / claim-after-success) makes
   at-least-once redelivery safe (no double-send).
4. **DLQ** — a failed send dead-letters for inspection / replay (backoff-retry is a follow-up).
5. **Separate repo** because comms is a leaf: **no shared domain logic** (no
   `computeAmount` etc.). It DOES share the Postgres (reads business tables, writes
   `comms_*`), so this is lifecycle independence, not zero-coupling — the ADR-0001
   reasons to stay in-monorepo do not apply.

## Stack

| Layer | bb-platform (producer) | bb-comms (worker) |
|---|---|---|
| Lang / runtime | TS / Node 20 | TS / Node 20 |
| Package mgr | pnpm (monorepo) | pnpm (pinned 10.33.2) |
| DB | **Prisma** (owns schema + migrations) | **Kysely** + `kysely-codegen` (reads schema it doesn't own; `types.generated.ts` committed) |
| Queue | amqplib (publisher) | amqplib (consumer) |
| Email | — (removed in F5) | **SES** `@aws-sdk/client-ses` |
| WhatsApp | — (removed in F5) | **Qontak** (fetch) |
| Templates | — | **MJML + Handlebars** (inline TS strings) |
| Logger / Build / Test | pino / tsup / vitest | pino / tsup / vitest |
| Deploy | pm2 (relay = 4th app in `ecosystem.config.js`) | **Docker** (validated) + pm2 + GitHub Actions CI |

Transport: RabbitMQ, dedicated `comms` vhost. Topology names (exchange/queues/routing
keys) are **code constants** (`mq/topology.ts`, identical in both repos); only
connection params live in env (memory `feedback_messaging_config`).

## Message types (5 — all e2e proven over a real broker)

| Type | Trigger | Channel | Recipient |
|---|---|---|---|
| `otp` | `otpService.issue` | WhatsApp + email | user |
| `CoursePaymentSuccess` | `commerce.payment.success` | email | buyer |
| `AffiliatorCommisionCourse` | `affiliate.commission.created` | email | earner |
| `CommerceRefunded` | `commerce.payment.refunded` | email | buyer |
| `CommercePaymentExpired` | `commerce.payment.expired` | email | buyer |

**Scope insight:** transactional templates are NOT 1:1 legacy ports — legacy was the
multitenant SELLER/chief world (out of scope). The new ones are clean buyer/earner
receipts from the new schema. 173 legacy templates → ~5 relevant types; the rest have
no trigger in the simplified backend (disbursement NOT STARTED, no scheduler for
reminders, social = in-app notification). Revisit when those modules/schedulers land.

## Tables (all in bb-platform `schema.prisma` — single migration authority)

| Table | Writer | Purpose |
|---|---|---|
| `notification_outbox` | bb-platform | dispatch queue (PENDING→SENT/FAILED); row id = message id |
| `comms_delivery` | bb-comms (Kysely) | one row per send attempt (SENT\|FAILED) — audit/observability |
| `comms_idempotency` | bb-comms (Kysely) | one row per delivered message — anti double-send |

`comms_delivery.id` uses a **DB-level** `gen_random_uuid()` default (Kysely writes it,
not Prisma — Prisma's `uuid(7)` is client-side and would leave it NULL).

## Phases (F1–F6)

| Phase | Outcome |
|---|---|
| F1 producer foundation | outbox + `comms_*` tables, tx-aware `enqueueComms`, RabbitMQ publisher, `comms-relay` daemon (pm2 auto) |
| F2 scaffold bb-comms | consumer loop, topology, idempotency, DLQ, Qontak |
| F3 OTP-WhatsApp | `otp.service` phone path → enqueue; **live e2e** |
| F4 templates | 5 types + SES + MJML renderer + `makeCommerceTxnEmailHandler` factory; email OTP moved too; **live e2e** |
| F5 cleanup | delete dead `mailer.service` + `whatsapp.service` + smtp/qontak env + nodemailer → bb-platform = pure producer |
| F6 deploy artifacts | Dockerfile (validated build + prod run), pm2 `ecosystem.config.cjs`, GH Actions CI, deploy docs |

Tests: bb-platform **310/310**, bb-comms **15/15**.

## Remaining — operator actions (not code)

1. Create remote `devtribelio/bb-comms` + push (repo is local-only); push bb-platform `feat/otp`.
2. Prod `pnpm prisma:deploy` (bb-platform) → migrate `notification_outbox` + `comms_*` to the prod DB.
3. Provision prod RabbitMQ `comms` vhost + inject bb-comms env (`DATABASE_URL`,
   `RABBITMQ_URL`, `QONTAK_*`, AWS SES).

## Gotchas

- **Migrations:** `prisma migrate dev` shadow replay is blocked by a pre-existing broken
  migration (`20260525075123`, `affiliate_visits_program_id_fkey`). Author new migrations
  via `migrate diff --from-url $DATABASE_URL --to-schema-datamodel` + hand-write
  `migration.sql` + `migrate deploy` (no shadow). Test DB is a separate Postgres
  (`localhost:5433/bb`) vs dev (`localhost:5432/bb_backend`) — deploy to both.
- **Topology constants** must stay byte-identical across both repos (`mq/topology.ts`) —
  separate repos share no code.
- **Local e2e:** RabbitMQ `amqp://admin:root@localhost:5672/comms` (vhost `comms` must
  exist); bb-comms `.env` `DATABASE_URL` must mirror bb-platform's dev DB.
- **bb-comms Docker:** pin `packageManager` pnpm@10.33.2 (corepack pulls pnpm 11,
  incompatible with Node 20); `pino-pretty` is a runtime dep (prod image with
  `NODE_ENV != production` crashes resolving the transport otherwise).
