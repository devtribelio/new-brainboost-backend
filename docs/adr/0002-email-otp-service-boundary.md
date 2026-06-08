# ADR-0002: Outbound communications service (separate repo)

- **Status:** Accepted (direction set by owner 2026-06-08; implementation deferred until first transactional template / Qontak wiring)
- **Date:** 2026-06-08
- **Deciders:** brainboost@tribelio.com
- **Related:** [`docs/email-scope.md`](../email-scope.md), [`docs/otp-port.md`](../otp-port.md), [`docs/legacy-providers.md`](../legacy-providers.md), [`docs/notification-port.md`](../notification-port.md) §12, [ADR-0001](0001-monorepo-split-for-backoffice.md), memory `[[feedback_messaging_config]]`

## Context

Where does outbound, non-push messaging live — email, phone OTP via WhatsApp (Qontak),
and other outbound notifications? Owner direction: a **separate git repo**, a worker,
**outside the `bb-platform` monorepo**.

Findings (full inventory in `docs/email-scope.md`):

1. **Legacy already runs email async, reading the DB for data.** `TBEmail::send($type, $id)`
   enqueues to 4 SQS tiers; a worker resolves `TBEmail_Engine_<Type>`, which **loads the
   model by `$id` from the database** (`TBModel::make(...)->find($this->id)`), builds the
   template data, renders an HTML view, and sends via SES. The queue message is a **light
   `{type, id}` reference, not a fat payload.** Phone OTP is a separate `TBQontak`
   (WhatsApp) path.

2. **Scope collapses to ~22 templates** (173 → 22 for mobile). 6 auth/OTP flows ship
   today; ~16 (commerce, affiliate, social, network) are pending, all event-driven.

3. **Current new-backend state is a parity gap.** `mailer.service.ts` sends
   synchronously in the request path (no queue, no retry, no HTML templating). Qontak
   outbound is not wired (`legacy-providers.md` T1.4).

4. **bb-comms shares the bb-platform Postgres** (owner decision). It does NOT carry all
   template data in the message — it follows the legacy Engine pattern: the message is a
   `{type, id}` reference, and the worker **reads the bb-platform Postgres** to resolve
   template data. It also **writes its own delivery-log / idempotency tables** in that
   same Postgres. So the repo split is about **lifecycle independence** (deploy, scale,
   on-call, template iteration), NOT about decoupling from the database. The split still
   buys: no shared **domain logic** (no `computeAmount`/affiliate rules), no Express
   stack, independent release cadence, channel growth localised to the comms repo.

5. **RabbitMQ is the trigger substrate** (`notification-port.md` §12 outbox; memory
   `[[feedback_messaging_config]]`: topology names as code constants, conn params in env,
   dedicated vhost).

### Owner decisions (2026-06-08)

- **Separate repo**, working name `bb-comms`. Not `apps/notification-worker`.
- **Transport:** RabbitMQ — the message is a lightweight **trigger** `{type, id, channel, priority}`.
- **Data source:** bb-comms **reads the bb-platform Postgres** to resolve template data
  (legacy Engine pattern).
- **Delivery log + idempotency:** stored in the **bb-platform Postgres**, in comms-owned
  tables (`comms_delivery`, `comms_idempotency`).
- **OTP code state** (gen/store/verify/consume on `otp_codes`) stays in bb-platform; bb-comms
  only delivers.
- **Scope:** outbound external channels only (email, WhatsApp, future SMS). In-app feed +
  FCM push remain in the backend `notification` module.
- **Template engine:** MJML + Handlebars.

## Decision

**Build a standalone repo `bb-comms` — a RabbitMQ-triggered outbound communications
worker — that reads the shared bb-platform Postgres for template data and sends via
SES (email) / Qontak (WhatsApp).** The monorepo backend is the producer: it generates a
trigger and publishes it through a transactional outbox.

### Architecture

```
bb-platform (monorepo backend)                 bb-comms (separate repo, worker)
────────────────────────────────              ──────────────────────────────────
otpService.issue()                             consume queue {type,id,channel,priority}
  → write otp_codes (hash) [txn]                 → (transactional) READ bb-platform PG by id
  → write Outbox row       [txn] ┐                  to resolve template data
domain event (payment, …)        │             → MJML+Handlebars render (templates live here)
  → write Outbox row       [txn] │             → SES / Qontak send
                                 ▼             → write comms_delivery + comms_idempotency
        relay daemon polls Outbox(PENDING)        (bb-platform PG, comms-owned tables)
                                 │  publish     → ack / nack→DLQ → retry
                                 ▼
                    ┌──────────────────────────┐
                    │ RabbitMQ (dedicated vhost) │  tiers: urgent | normal
                    └──────────────────────────┘
                                 │
            ┌────────────────────┴─── reads ───────────────────┐
            ▼                                                   ▼
   bb-platform Postgres  ◄──────── bb-comms reads (data) + writes (comms_* tables)
```

- **Message = trigger, not payload.** `{ v, type, id, channel, priority }`. The worker
  reads bb-platform Postgres by `id` to build the data — same as legacy `TBEmail_Engine`.
- **OTP is the exception.** `otp_codes` stores only the **bcrypt hash** — the plaintext
  code cannot be re-derived. So OTP messages carry the code inline:
  `{ v, type:'otp', channel, to, code, name?, ttl }`. Sensitive → dedicated vhost + TLS
  connection + short message TTL + never log the body. OTP `issue()` swaps its direct
  `whatsappService.sendOtp`/`mailer.send` for an outbox write; `verify`/`consume` are
  untouched (in-process `otp_codes` read).
- **Transactional outbox** in bb-platform Postgres (`notification-port.md` §12) avoids the
  dual-write race: domain mutation + outbox row commit in one Prisma transaction; a relay
  daemon publishes PENDING rows → at-least-once.
- **Idempotency:** worker checks `comms_idempotency` (keyed by outbox row id / message id)
  before sending → safe against at-least-once redelivery.
- **RabbitMQ topology** per `[[feedback_messaging_config]]`: exchange + `urgent`/`normal`
  queues as code constants, conn params in env, dedicated vhost. Tiers mirror legacy
  `sqsUrgent` (OTP, payment, disbursement) vs `sqs` (reminders, digests).

### Stack (bb-comms)

| Layer | Choice | Note |
|---|---|---|
| Language / runtime | TypeScript, Node ≥20 | match ecosystem |
| Package manager | pnpm | match |
| Queue consumer | `amqplib` (RabbitMQ) | trigger transport |
| Postgres access | **Kysely** (+ `kysely-codegen`) — read bb-platform tables; write `comms_*` | shared DB; type-safe query builder over a schema it does not own |
| Email send | SES via `@aws-sdk/client-ses` (or nodemailer SES transport) | legacy used SES |
| WhatsApp | Qontak client ported from `whatsapp.service.ts` | fetch-based |
| Template engine | **MJML + Handlebars** | responsive email + variable interpolation; templates live in bb-comms |
| Logger | pino | match |
| Config | env `required()` pattern | match bb-platform |
| Build | tsup | match |
| Test | Vitest | match |
| Health / preview | optional small Fastify (`/health` + template preview) or bare `http` | not an API |

Process shape = consumer loop, **not** an Express API. No `@bb/db` import of bb-platform's
Prisma client package.

**Why Kysely (not Prisma) for bb-comms:** bb-comms does **not own** the schema — the
migration authority is bb-platform `schema.prisma` (ADR-0001). Prisma's core value
(migrations + schema ownership) would be disabled here, leaving a duplicate
`schema.prisma` that must be re-`db pull`ed on every read-table change and silently
drifts. Kysely fits a **consumer of a schema it does not own**: `kysely-codegen`
generates types directly from the live DB (no second schema file to sync), and it cleanly
reads bb-platform tables + writes `comms_delivery` / `comms_idempotency`. bb-platform
itself stays on Prisma — this choice is local to bb-comms.

### Migration ownership of `comms_*` tables (open, recommended resolution)

Single Postgres, two writers. Recommended: bb-platform `prisma/schema.prisma` remains the
**single migration authority** (per ADR-0001) and declares `comms_delivery` /
`comms_idempotency`; bb-comms treats them as read/write but does **not** migrate. Revisit
if comms needs to evolve its tables independently → then carve a dedicated schema/owner.

### The contract (cross-repo shared surface)

Two surfaces now, both versioned:
1. **Message shape** — `{ v, type, id, channel, priority }` (+ OTP inline-code exception).
2. **Read-schema** — the bb-platform tables/columns bb-comms reads per `type` to build data.
   A schema change to a read table is a cross-repo breaking change; document the read set
   per `type` in the bb-comms repo and bump `v` on incompatible changes.

## Consequences

### Positive

- **Independent lifecycle.** Comms deploy, scale, on-call, and template iteration are
  decoupled from the mobile backend. A Qontak outage or slow SES never touches the API
  process.
- **No shared domain logic.** No payout math / affiliate rules cross the boundary — the
  ADR-0001 duplication hazard does not apply.
- **OTP stays fast.** Verify is an in-process DB read; only delivery is offloaded.
- **Light messages.** `{type,id}` triggers keep the queue small; data is read fresh from
  PG at send time (no stale snapshot in the queue).
- **One async substrate** (RabbitMQ) shared by push planning + external comms.
- **Templates decoupled from backend releases** (MJML lives in bb-comms).

### Negative

- **Database coupling is real.** bb-comms depends on the bb-platform Postgres **read
  schema**; a column rename in a read table can break a template silently. Needs the
  documented read-set contract + contract tests. (This is the cost of the legacy
  Engine pattern; accepted by owner.)
- **Two writers, one DB.** `comms_*` table migration ownership must be agreed (see above)
  or migrations race.
- **A whole separate repo to operate:** own CI/CD, Dockerfile, deploy, secrets, plus
  standing up RabbitMQ (dedicated vhost) + the relay daemon.
- **Two contract surfaces** (message shape + read schema), neither compiler-enforced
  end-to-end → versioning discipline + contract tests on both sides.
- **OTP plaintext on the wire.** Code travels in the message (can't be read from the
  hash). Mitigate: dedicated vhost, TLS, short message TTL, no body logging. (Legacy had
  the same reality over SQS.)
- **Eventually-consistent delivery.** Delayed/lost sends possible if broker + outbox +
  worker all fail; needs DLQ + alerting.

### Neutral

- OTP parity rules (`docs/otp-port.md`) + `otp_codes` schema unchanged.
- `notification-port.md` §12 outbox table lives in bb-platform either way; now shared by
  FCM push (backend) + external comms (bb-comms relay source).
- Backend keeps a thin **enqueue** helper in `@bb/common`; `mailer.service.ts` (SMTP) +
  `whatsapp.service.ts` (Qontak) **move to bb-comms**.

## When to act (pull, not push)

Stand up `bb-comms` when the **first** lands:

- First transactional email ported (commerce/affiliate — bucket B/C, `docs/email-scope.md`).
- Qontak WhatsApp OTP wired (`legacy-providers.md` T1.4) — the natural first slice
  (one channel, the OTP inline-code message type, proves the contract end to end).

Until then, the inline `mailer.service.ts` + Qontak "log instead of send" stub remain
adequate for the 6 auth/OTP flows. **Do not build `bb-comms` speculatively.**

## Alternatives considered

### A. App inside the monorepo (`apps/notification-worker`)

Rejected by owner — wants an independent repo lifecycle. Technically viable.

### B. Pure DB-as-queue (drop RabbitMQ, poll outbox)

Rejected. bb-comms reads the PG anyway, so polling is tempting — but it loses push
latency, priority tiers, and broker-native retry/DLQ, all of which would be hand-rolled.
RabbitMQ stays as the **trigger**; PG is the **data source**. (Note: the "shared PG"
concern from the original draft is now **partially accepted** — PG is shared for reads +
comms-owned delivery tables — but the broker still drives dispatch.)

### C. Synchronous HTTP backend → comms

Rejected. Backend would block/retry against comms; loses async + at-least-once.

### D. Fat-payload messages (all data in the queue, no PG read)

Rejected by owner direction. Bloats the queue, snapshots stale data, and duplicates the
backend's data shapes into message schemas. The legacy `{type, id}` + DB-read pattern is
leaner and fresher. (OTP remains the lone inline-data exception, by necessity.)

## Revisit triggers

- Read-schema contract churn becomes painful → consider a published read-model contract
  package or a stable DB **view** layer that comms reads (insulates from table changes).
- `comms_*` tables need independent evolution → give comms its own schema/migration owner
  (or its own DB).
- A second consumer of `bb-comms` appears outside `bb-platform` (e.g. b2b backend) →
  formalise the message + read contract as a versioned package.
- Comms volume/latency needs co-location → reconsider folding back as
  `apps/notification-worker` (alternative A).
