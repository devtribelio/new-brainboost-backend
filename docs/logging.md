# Logging & Request Tracing — Design

Structured, correlated logging for the whole request lifecycle: request in →
route → guard → service → DB → response out. Implemented as an Express
interceptor plus a pino mixin, so the ~60 existing `logger.*` calls in
`@bb/domain` gained correlation **without a single call-site change**.

- **Context store:** `packages/common/src/config/request-context.ts`
- **Logger:** `packages/common/src/config/logger.ts`
- **Redaction:** `packages/common/src/config/log-redaction.ts`
- **Interceptor:** `packages/common/src/middlewares/request-logger.middleware.ts`
- **Service spans:** `packages/common/src/utils/trace-service.ts`
- **DB layer:** `packages/common/src/config/prisma-logging.ts` + `packages/db/src/index.ts`
- **Route tagging:** `packages/common/src/openapi/route-binder.ts`
- **Tests:** `apps/mobile-api/tests/request-logging.spec.ts`,
  `apps/mobile-api/tests/trace-service.spec.ts`

Built on [pino](https://getpino.io) v9 + Node's `AsyncLocalStorage`.

---

## 1. What it replaced

| Before | After |
|---|---|
| `morgan` (`dev`/`combined`) writing free-form text to stdout | `requestLogger` writing one JSON line per request |
| Two unrelated log streams (morgan + pino) | One pino stream |
| No correlation id — a service log could not be tied to its request | `requestId` on **every** line, echoed as `X-Request-Id` |
| Error logs with no request context | `requestId` / `route` / `userId` / `errorCode` on the error line |
| No duration, no slow-request signal | `durationMs` + `slow: true` past a threshold |
| Prisma dumping raw SQL to stdout (including in tests) | `db.op` (correlated) at `debug`, `db.query` (raw SQL) at `trace` |
| Secrets loggable by accident | pino `redact` on ~19 key names, anywhere in the object |

`morgan` was removed from `package.json` and `apps/mobile-api/package.json`.

---

## 2. How correlation works

The trick is that **nothing in the service layer knows about logging context**.

1. `requestLogger` opens an `AsyncLocalStorage` context per request holding
   `{ requestId, method, path, route, handler, userId, errorCode, ip, startedAt }`.
2. `logger`'s pino `mixin()` reads that context on **every** log call and merges
   `requestId` / `userId` / `route` into the line.
3. Anything running inside the request — middleware, controller, `@bb/domain`
   service, Prisma `$use` middleware — inherits it through the async chain.

Outside a request (workers, cron, `scripts/`, tests) there is no context and the
mixin adds nothing, so the same `logger` works everywhere.

Enrichment points, in order:

| Field | Set by |
|---|---|
| `requestId`, `method`, `path`, `ip` | `requestLogger`, on arrival |
| `route`, `handler` | `bindRoute`'s tag handler, once Express matched the layer |
| `userId` | `authGuard` / `authGuardLenient` / `optionalAuthGuard` / `anonOrMemberGuard` |
| `errorCode` | `errorHandler` |
| `status`, `durationMs`, `contentLength` | `requestLogger`, on `finish` |

`route` is stamped **before** the route's own middlewares run, so a 401 from a
guard is still attributed to the endpoint that produced it.

---

## 3. Request id

- Inbound `X-Request-Id` is **reused** when it matches `^[A-Za-z0-9._:-]{8,64}$`,
  so a trace started by a proxy or the mobile client joins up with ours.
- Anything else (absent, too short, too long, unsafe characters) gets a fresh
  `randomUUID()`. A rejected value is *replaced*, not sanitised — inbound ids
  land in log files, and a half-stripped id is a log-injection vector.
- Always echoed back in the `X-Request-Id` response header, so a user can quote
  it in a bug report and the whole request can be pulled from the logs.

---

## 4. The log lines

| `msg` | When | Level |
|---|---|---|
| `http.request` | on arrival, only if `LOG_HTTP_INCOMING=true` — carries `query` (see §4c) | info |
| `http.response` | response fully flushed | see below |
| `http.aborted` | socket closed before the response finished (client gone, timeout, crash mid-stream) | warn |
| `service.call` | one per controller→service method call — service, method, `durationMs`, `outcome` | debug |
| `db.op` | one per Prisma call, at `debug` — model, operation, `durationMs`, **correlated** | debug |
| `db.query` | raw SQL + engine timing, at `trace` — **not** correlated (see §5) | trace |

`http.response` level: `5xx` → **error**, `4xx` → **warn**, slow or aborted →
**warn**, otherwise **info**. A slow 2xx is a warn on purpose: that is the line a
latency alert should fire on.

Example (pretty-printed dev output):

```
INFO: http.response
    requestId: "smoke-matched-route"
    route: "/api/member/data/location/country"
    method: "GET"
    path: "/api/member/data/location/country"
    handler: "LocationController.listCountries"
    status: 200
    durationMs: 225.3
    ip: "::ffff:127.0.0.1"
    userAgent: "smoke/1.0"
    contentLength: 947
    query: { "limit": "1" }
```

---

## 4c. Where the input lives, and why

Both `query` and `body` are **captured as the client sent them** but reported on
the **response** line by default. Three separate decisions:

**1. Query is snapshotted on arrival, not read at response time.** It has to be:
`validateDto(Dto, 'query')` does `req.query = plainToInstance(...)` with
`enableImplicitConversion` + `whitelist`, so by response time `req.query` has
coerced types and has silently dropped every param the DTO does not declare. A
`?perPag=100` typo would be invisible. Symptom of the old behaviour: `"page": 1`
as a *number*, when a query string can only ever produce `"1"`. The snapshot lives
on the request context (`RequestContext.query`).

**2. Body cannot be on the arrival line — physically, not by preference.**
`requestLogger` is the first middleware; at that point `express.json()` has not
read the body off the socket, and for a streamed request the bytes may not have
arrived at all. There is nothing to log yet. It is read at response time from the
raw buffer (see §6), which is immune to the DTO rewrite for the same reason the
query snapshot is.

**3. Both stay on the response line even when `LOG_HTTP_INCOMING` is on.** The
response line is meant to be a *self-contained row per request*: input, outcome,
timing, error code. That keeps CloudWatch Insights / `jq` / grep queries to one
row with no join, which is worth more than the duplicated bytes in the rare
debugging mode where the arrival line is enabled too. `http.request` exists for
requests that hang or crash and therefore never produce a response line.

---

## 4b. Service-layer visibility — two separate things

These are often confused, so to be explicit:

**Correlation is automatic and needs no opt-in.** Any `logger.*` call in
`@bb/domain` — all ~60 that already existed — comes out with `requestId` and
`route` attached, because the mixin reads the ambient context. Verified end to end:
a `POST /api/member/affiliate/visits` produces
`affiliate.visit.unknown_affiliator` (a plain `logger.warn` inside
`visit.service.ts`) carrying `requestId` + `route`, and that service knows nothing
about HTTP.

**Timing is NOT automatic** — a service method that logs nothing used to be
invisible, so "which call ate the 800 ms" had no answer beyond the DB lines.
`traceService()` (`packages/common/src/utils/trace-service.ts`) closes that: it
proxies a service instance and emits a `service.call` span per method call
(`service`, `method`, `durationMs`, `outcome: ok|error`, plus the error CLASS on
failure). Applied at the route boundary in all 21 `*.routes.ts` files:

```ts
const ctrl = new AffiliateController(traceService(new VisitService()), …);
```

Deliberate limits:

- **Self-calls are not traced.** Methods run with the raw instance as `this`, so
  `this.helper()` inside a service produces no second span — nesting would
  double-count the same wall clock and bury the entry point.
- **Services instantiated inside other services / listeners / jobs are not
  traced.** The rule is "the call the controller makes"; wrap manually if a
  background path needs it.
- **Arguments are never logged.** They are full of emails, phones and tokens, and
  a service signature is not a shape pino's redact can reason about.
- **Zero cost when off:** the wrapper checks `logger.isLevelEnabled('debug')` and
  calls straight through — no timer, no closure work, no line.

Together the three tiers localise latency without a tracing backend: total
(`http.response.durationMs`) → per service call (`service.call`) → per query
(`db.op`). Subtract to find the non-DB time.

### Reading the id as a value

A service that needs the id itself (to stamp an outbound call, a queue message, an
audit row) imports it — no constructor plumbing:

```ts
import { getRequestId, getRequestContext } from '@bb/common/config/request-context';
```

Both return `undefined` outside a request, so the same code is safe in a worker.

### How far the context actually reaches

Asserted in `apps/mobile-api/tests/request-context-propagation.spec.ts`, not assumed:

| Reaches | Why |
|---|---|
| ✅ any depth of `await` in a service | AsyncLocalStorage follows async continuations |
| ✅ domain event listeners (`commerceEvents.emit` etc.) | `emit()` is synchronous, so the listener runs in the *caller's* context even though it was registered at boot |
| ✅ fire-and-forget `void fn().catch(…)` | same async chain |
| ✅ Prisma `$use` middleware → `db.op` | runs in the caller's context |
| ❌ Prisma engine query events → `db.query` | engine emits from its own context (§5) |
| ❌ cron / jobs-runner / workers | no HTTP request exists — by design, mixin adds nothing |
| ❌ **anything crossing a process boundary** | see below |

Concurrent requests never see each other's context (also asserted).

**The one real gap: process boundaries.** `notification_outbox` → SQS → **bb-comms**
(separate repo) and `notification-worker` start a fresh context, so a delivery
failure over there cannot be traced back to the request that queued it. Closing it
means carrying the id in the message: the outbox row has a `payload Json?` column
that could hold it with no migration, but bb-comms has to read and re-open a
context on the other side — a cross-repo change, deliberately not done here.

**Listener failures used to lose the id.** All three event buses caught listener
rejections with `console.error`, which bypasses pino entirely — unstructured and
uncorrelated. Now `logger.error({ err, event }, '<bus> listener threw')`, with a
regression test. (`apps/resync-worker/` still uses `console.*` throughout; it is a
throwaway CLI retired after cutover, deliberately left alone.)

---

## 5. DB logging — two tiers, and why only one is correlated

`packages/db` emits Prisma's `query`/`info` as **events** instead of writing them
to stdout (`error`/`warn` deliberately stay on stdout: many entrypoints never
call `attachPrismaLogging()`, and an unsubscribed event would silently lose DB
errors). `attachPrismaLogging()` — called from `apps/mobile-api/src/main.ts` —
subscribes and adds a `$use` middleware.

- **`db.op` (debug) is correlated.** `$use` runs inside the *caller's* async
  context, so the `AsyncLocalStorage` request context is still there.
- **`db.query` (trace) is not.** Prisma's engine emits query events from its own
  async context; by then the request context is gone. Use `db.query` to read the
  SQL, `db.op` to attribute it.

`$use` is deprecated in favour of `$extends`, but `$extends` returns a client
whose *type* differs from `PrismaClient` — adopting it means changing what
`@bb/db` exports and re-typing every consumer. Revisit on the Prisma 6 upgrade.

**Query params are never logged.** They routinely hold emails, phone numbers,
password hashes and OTP codes, and unlike a structured field they cannot be
covered by pino's `redact`.

---

## 6. Redaction — two layers

Key list lives in `packages/common/src/config/log-redaction.ts` and is used twice:

```
password, newPassword, oldPassword, currentPassword, passwordConfirmation,
token, accessToken, refreshToken, idToken, authorization, apiKey, secret,
clientSecret, otp, otpCode, pin, nik, sessionToken
```

**Layer 1 — pino `redact`** (`config/logger.ts`): covers *every* log call in the
codebase, so an accidental `logger.info({ body })` in some service is safe. Paths
are matched literally, i.e. the bare key and one level deep (`*.key`), plus
`req.headers.authorization` / `cookie`.

**Layer 2 — `scrubDeep()`** (applied by `requestLogger` to the request body and the
query string): a depth-bounded deep copy with secret-named properties replaced, at
*any* nesting level. Two reasons pino's redact is not sufficient here:

1. **Truncation defeats redact.** An over-cap body is logged as a JSON *string*,
   and redact only walks object keys — a secret inside it would print verbatim.
   So the order is **scrub first, truncate second**. There is a regression test
   for exactly this (`scrubs BEFORE truncating…`).
2. **Depth.** `*.password` catches `body.password` but not `body.user.password`
   or `body.devices[0].idToken`.

`scrubDeep` never mutates the input (mutating `req.body` would corrupt the request
being served) and is bounded — depth 8, 200 keys, 50 array entries — so a hostile
or cyclic payload cannot turn logging into a hang.

### Request body specifics

- Off by default in **production** and **test**, on in **development**
  (`LOG_HTTP_BODY`).
- **Read from the RAW bytes, not `req.body`.** `validateDto` replaces `req.body`
  with the transformed, whitelisted DTO instance, so by the time the response line
  is written every undeclared property is already gone. Logging that version hides
  the most common client bug there is — a misspelled or renamed field silently
  dropped. `rawJsonBody()` reads the buffer kept by `express.json`'s `verify` hook
  (the same hook the Didit webhook signature needs) and falls back to `req.body`
  for urlencoded / multipart.
- A **malformed** JSON body is reported as `[unparseable json body N b]`, never
  echoed: broken JSON cannot be walked structurally, so it cannot be scrubbed, and
  a body with a stray brace still contains the password.
- Omitted entirely for `GET` / `HEAD` / `OPTIONS`, and for an empty body.
- Truncated at 2 000 chars, with `…[truncated N b]` appended.
- `multipart/*` logs the text fields under `{ fields: … }` (or `[multipart]` when
  there are none) — the uploaded FILE goes through multer and is never in
  `req.body`, so saying "empty" would be misleading.
- **Response bodies are never logged.** They are large, derived from state you can
  reproduce, and are the single easiest way to dump an entire user's PII into a
  log file.

---

## 7. Configuration

| Env | Default | Meaning |
|---|---|---|
| `LOG_LEVEL` | `info` | pino level. `debug` adds `db.op`; `trace` adds `db.query` |
| `LOG_HTTP` | `true` (`false` under `NODE_ENV=test`) | emit the access line at all |
| `LOG_HTTP_INCOMING` | `false` | also log `http.request` on arrival — for requests that hang or kill the process before any response |
| `LOG_HTTP_BODY` | `true` under `NODE_ENV=development`, else `false` | attach the (deep-redacted, 2 KB-truncated) request body to the response line. **Never leave on in production** |
| `LOG_SLOW_REQUEST_MS` | `1000` | above this, the line is warn + `slow: true` |
| `LOG_IGNORE_PATHS` | `/health,/api/docs` | comma-separated prefixes excluded from access logging |
| `LOG_PRISMA` | `true` (`false` under `NODE_ENV=test`) | attach the Prisma → pino bridge |

The request **context** is opened even for ignored paths — only the access lines
are suppressed — so a `/health` handler that logs is still correlated.

---

## 8. Mount order (matters)

`requestLogger` goes **first** in `apps/mobile-api/src/app.ts`, right after the
`trust proxy` setting it depends on for the client IP, and before
helmet/cors/body-parsing. That way a rejected preflight, a 429 from the rate
limiter, or a malformed-JSON 400 still produces a log line — and every
downstream log carries the id.

---

## 9. Known gaps / next steps

- **Nothing ships the logs anywhere yet.** stdout only; on ECS that lands in
  CloudWatch via the awslogs driver. A real query/alert layer (metric filters on
  `status>=500`, `slow:true`, `http.aborted`) is not set up.
- **No sampling.** At high volume `db.op` at `debug` is expensive — keep prod at
  `info` and raise the level per-incident.
- **Workers are not instrumented.** `notification-worker` / `resync-worker` /
  `jobs-runner` log through the same `logger` but have no ambient context. If
  per-job correlation is wanted, open a context with `runWithRequestContext`
  around each job (a `jobId` instead of a `requestId`).
- **`route` is unset for 404s** — no Express layer matched, so there is nothing
  to attribute. `path` still tells you what was asked for.
