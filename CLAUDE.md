# CLAUDE.md — bb-backend-new

Operational instructions for working on this repo. Keep responses short; read deeper context only when needed.

---

## 1. Project Context

- **What this is:** `bb-backend-new` — the new Brainboost mobile backend. Express + TypeScript + Prisma (PostgreSQL).
- **What it replaces:** `tribelio-platform` (a.k.a. *ittron* monolith) — legacy PHP/Cresenity framework hosting `tribelio/`, `tribelio-admin/`, `tribeliopage/`, `cresenity/`, `shortlink/` apps. Today's app exposes `GROUP_MEMBER` / `GROUP_CREATOR` / `GROUP_ORACLE` over a single `Controller_Api` (see `application/tribelio/default/controllers/api.php`).
- **Relationship:** full rewrite, not a bridge. Mobile clients still hit legacy until each module is cut over. The `legacyId` (Int) column on each model is a mobile-compat int ID — it is **not** a sign that the column should be dropped.
- **Stack delta:**

  | | Legacy | New |
  |---|---|---|
  | Language | PHP 7.x | TypeScript (Node ≥20) |
  | Framework | Cresenity (CodeIgniter-derived) | Express 4 |
  | ORM | Custom `CDatabase` / `TBModel_*` | Prisma 5 |
  | DB | MySQL/MariaDB | PostgreSQL |
  | Auth | OAuth2 (`Controller_Api::resolveMethod`) | JWT (access + refresh) |
  | Routing | Convention-based controllers | Module-per-feature (see `src/core/register-modules.ts`) |
  | DI | Static helpers (`TB::`, `TBApi::instance`) | Manual instantiation in `*.routes.ts` |
  | Tests | PHPUnit | Vitest |
  | Package mgr | composer | pnpm |
  | Validation | Ad-hoc | `class-validator` + `class-transformer` |
  | OpenAPI | None | `class-validator-jsonschema` + custom registry |

- **Rewrite goals:** mobile-only API surface; PostgreSQL primary; clean module boundaries; OpenAPI/Swagger first-class; affiliate accuracy parity with legacy.
- **NOT porting:**
  - Web/Blade views (`application/tribelio/default/views/**`), creator studio, canvas builder, page builder.
  - `tribelio-admin/` (separate legacy app — new admin lives inline at `src/modules/admin/` with EJS server-side views).
  - `shortlink/`, `cresenity/` apps.
  - Multi-tenancy (`org_id`, `network_account_id`) — single-tenant.
  - Super-affiliate / chief tiers.
  - Per-program rate config (constants in code only).

---

## 2. Repository Structure

> **pnpm monorepo** (ADR-0001, Accepted). The old single `src/` tree was split into
> shared `packages/*` + deployable `apps/*`. Repo dir + remote stay
> `new-brainboost-backend` (rename to `bb-platform` deferred). `node-linker=hoisted`
> (`.npmrc`). Dev: `pnpm dev:mobile` (tsx `--conditions=development` → resolves `@bb/*`
> to package source). Prod build: `tsup` per app (bundles `@/*` + `@bb/*`).
> Tests: `pnpm test` (vitest workspace, real Postgres).
> **`apps/backoffice-api` + `apps/admin-ejs` REMOVED 2026-07** (never deployed;
> recoverable from git history — branch `feat/voucher`, pre-removal).

```
packages/
  db/        @bb/db        # Prisma client singleton + re-export @prisma/client (dep-free)
  common/    @bb/common    # exceptions, interfaces, middlewares, openapi, serializers,
                           #   services (mailer/otp/settings/system-config/xendit*),
                           #   utils, events, config/{env,logger}, core/module.interface
  domain/    @bb/domain    # shared business services + rules (NO Express):
                           #   commerce, affiliate, notification, voucher, post.service,
                           #   comment.service, jobs/, registerDomainListeners()
apps/
  mobile-api/     :3000    # member-facing API. app.ts/main.ts/core/register-modules +
                           #   modules/<feature>/{module,routes,controller,dto,serializer}.
                           #   service layer of shared features lives in @bb/domain.
  notification-worker/     # background notification/push worker
prisma/                    # SINGLE source of truth — schema.prisma (UUID v7, legacyId Int?),
                           #   migrations/, seeds/  (root-level, shared by all apps)
tests/setup.ts             # shared vitest setup; specs live in apps/*/tests/
```

Each consumer maps `@bb/*` paths to built `dist` for `tsc` typecheck; node/tsx/vitest
resolve via package `exports`. Add a new mobile module under `apps/mobile-api/src/modules/`
and register it in that app's `core/register-modules.ts`.

### Legacy → New module map

> Path note (post ADR-0001): `src/modules/<feature>/` in the rows below now lives at
> **`apps/mobile-api/src/modules/<feature>/`**; `src/modules/admin/` → `apps/admin-ejs/` and
> `src/modules/backoffice/` → `apps/backoffice-api/` (both apps REMOVED 2026-07). Service/rule layer of
> commerce/affiliate/notification + post/comment services moved to **`packages/domain/`**;
> `src/common/*` + `src/config/{env,logger}` → **`packages/common/`**; prisma client →
> **`packages/db/`**.

| Legacy path | New module | Notes |
|---|---|---|
| `application/tribelio/default/controllers/login.php`, `account.php` (auth bits) | `src/modules/auth/` | OAuth2 → JWT. Endpoints under `/api/member/oauth/*`, `/api/member/auth/*` |
| `application/tribelio/default/controllers/account.php` + `libraries/TBMember.php` | `src/modules/account/` | Profile/account ops, change password, logout, pre-registration |
| `application/tribelio/default/controllers/member.php`, `members.php` + `TBApi.php` (GROUP_MEMBER) | `src/modules/member/` | Member info, listing |
| (profile section of `account.php`) + `libraries/TBProfile.php` | `src/modules/profile/` | Profile detail + update |
| `application/tribelio/default/controllers/data.php` (location) | `src/modules/location/` | country/province/city/district |
| `application/tribelio/default/controllers/upload.php` + `libraries/TBAsset.php` | `src/modules/upload/` | File upload (multer) |
| `libraries/TBBanner.php` | `src/modules/banner/` | Banner listing |
| `application/tribelio/default/controllers/product.php`, `commerce.php` + `libraries/TBProduct.php`, `TBCommerce.php`, `TBCourse.php`, `TBPlan.php` | `src/modules/product/` | Course/product detail (legacy parity per `feat/base-update`) |
| mobile `BunnynetService`, `ProductService::downloadAudio` | `src/modules/media/` | BunnyCDN Stream proxy — hides `guid`/`library_id` from FE |
| `libraries/TBCommision.php` | `src/modules/commission/` | Commission listing (read-only for now) |
| `libraries/TBAffiliate.php`, `TBAffiliator.php`, `TBAffiliator_Commision_CoursePayment` | `src/modules/affiliate/` | Affiliate program, attribution, visit logging, payout compute. See `plan.md` |
| `application/tribelio/default/controllers/topic.php` | `src/modules/topic/` | Topic CRUD |
| `application/tribelio/default/controllers/post.php` + `libraries/TBPost.php` | `src/modules/post/` | Posts, feed |
| `application/tribelio/default/controllers/post.php` (comment bits) + `libraries/TBComment.php` | `src/modules/comment/` | Comments |
| (reply section of comments) | `src/modules/reply/` | Replies |
| `application/tribelio/default/controllers/network.php`, `networkAccount.php` + `libraries/TBNetwork.php` | `src/modules/network/` | Networks/communities |
| `libraries/TBReport.php` | `src/modules/report/` | User report |
| `libraries/TBNotification.php` | `src/modules/notification/` | Notification feed |
| `tribelio-admin/` (separate legacy app) | `src/modules/admin/` | New admin: EJS server-side, JWT cookie, `crud-factory`. Internal sysadmin scaffold over Prisma entities. |
| `tribelio-admin/` product-ops controllers + `application/tribelio/default/libraries/TBApi/Oracle/Method/**` + `controllers/api.php::oracle()` dispatcher | `src/modules/backoffice/` | NEW. JSON-only REST under `/api/backoffice/*` consumed by external backoffice SPA. Reuses `Admin` table + bearer JWT + RBAC (4 roles) + 2FA + audit log. Plan: `docs/backoffice-port-plan.md` (+ per-cluster files in `docs/backoffice-port/`). |

For deep symbol-level mapping see `docs/legacy-analysis.md`.

---

## 3. Code Navigation Rules (jcodemunch)

**Always use jcodemunch for code lookup on both repos.** Indexed repo IDs:

- New: `devtribelio/new-brainboost-backend`
- Legacy: `tribelio-platform`

### Default workflow

1. `get_repo_outline {repo}` — sanity check.
2. `get_file_outline {repo, file_path}` — see symbols + signatures of a file before reading it.
3. `search_symbols {repo, query, file_pattern?, kind?}` — locate by name/topic.
4. `get_symbol_source {repo, symbol_id}` — fetch the function body.

### Hard rules

- **Never `cat` / Read a full source file blindly.** Run `get_file_outline` first; only `get_symbol_source` for the symbols you actually need. (Prisma `schema.prisma`, `package.json`, configs are OK to Read directly.)
- **Before assuming dead code:** run `find_importers {repo, file_path}`. `has_importers=false` on a chain == dead.
- **Unclear purpose:** run `get_symbol_provenance {repo, symbol}` to see commit lineage / authorship narrative.
- **After any edit:** run `index_file {path: <abs path>}` to keep the index fresh. Edits to files outside indexed scope: rerun `index_folder`.
- **Legacy lookups:** prefer `search_symbols` with `file_pattern: "cresenity-app/application/tribelio/**"` to avoid noise from `cresenity-app/system/**` framework code.
- **Cross-repo:** when porting a symbol, run `search_symbols` in both repos to confirm naming and find any partial implementation in the new repo.

### When jcodemunch isn't enough

- String/literal search → `search_text {repo, query}` (regex supported).
- Full git log on a symbol's file → `get_symbol_provenance`.

---

## 4. Architecture & Patterns

### Keep it simple (default posture — overrides "clever")

- **Keep it simple.** Prefer straightforward solutions over clever ones.
- **Don't over-engineer.** No abstraction, pattern, or layer until it's actually needed. No interface with one implementer, no config knob with one value, no generic helper called once.
- **Don't add unrequested features/handling.** Scope = what was asked. Extra error branches, extra flags, extra endpoints = scope creep.
- **10 lines beats 50 lines** when the result is identical. Pick the 10.
- **No premature optimization.** Write the obvious version; optimize only with a measured problem.
- **Code to the point, minimal boilerplate.** No ceremony wrappers, no comment restating the code.

### Already decided

- **Module-per-feature** under `src/modules/<feature>/`. Each module exports an `AppModule` (`name`, `prefix`, `routes()`).
- **Routing:** `bindRoute({ router, controller, method, path, handlerKey, middlewares })` from `src/common/openapi/route-binder.ts`. This registers the Express route AND the OpenAPI entry in one call. Always use `bindRoute` — never `router.post(...)` directly.
- **DI:** manual instantiation in `*.routes.ts` (`new Controller(new Service())`). No tsyringe (see memory `[[feedback_di]]`).
- **Validation:** DTOs use `class-validator` decorators. `validateDto(Dto)` middleware transforms + validates `req.body` (or `req.query` with the `'query'` source variant).
- **Auth:** `authGuard` middleware reads `Authorization: Bearer <jwt>` and attaches `AuthenticatedUser` to `req.user`. Routes that need auth list `authGuard` first in `middlewares`.
- **Responses:** use `ok(res, data, meta?)` / `okCreated(res, data, meta?)` / `okPaginated(res, items, {page,perPage,total}, extraMeta?)` / `fail(res, status, code, message, details?)` from `src/common/utils/response.util.ts`. Standard envelope: `{ success: boolean, data, meta, error }`. Pagination metadata lives at `meta.pagination = { page, perPage, total, totalPages }`. See `docs/api-envelope.md` for the full spec.
- **Exceptions:** throw `BadRequestException` / `UnauthorizedException` / `ForbiddenException` / `NotFoundException`. `errorHandler` middleware maps them to `{ success:false, error:{ code, message, details? } }`. Default error codes: `BAD_REQUEST`, `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `INTERNAL_ERROR`.
- **IDs:** UUID v7 (`@default(uuid(7)) @db.Uuid`) repo-wide. **`legacyId Int? @unique`** on every entity that maps to legacy — the mobile app still passes int IDs (see memory `[[project_rewrite_context]]`).
- **Logger:** `pino` (`packages/common/src/config/logger.ts`). Don't `console.log`. Just call `logger.*` with a flat object — **never thread a request id through a service**: an `AsyncLocalStorage` context (`config/request-context.ts`) plus pino's `mixin` stamps `requestId` / `route` / `userId` onto every line automatically. `requestLogger` (mounted first in `app.ts`, replaced `morgan`) opens that context and emits one `http.response` / `http.aborted` line per request with status + `durationMs`; `service.call` (`traceService()` wrapping every service in `*.routes.ts`) covers the service hop; `db.op` (Prisma `$use`) covers the DB hop — both at `debug`. Secrets are stripped by pino `redact` **and** by `scrubDeep()` for request bodies. Spec: `docs/logging.md`.
- **Env:** `src/config/env.ts` uses `required('FOO')` — every env var has one declaration here.

### Naming conventions

- Files: `kebab-case.ts` (`auth.service.ts`, `change-password.dto.ts`).
- Classes: `PascalCase` ending in role (`AuthService`, `LoginDto`).
- Routes are `/api/<prefix>/<legacy-style-path>` to match the mobile client (e.g. `/api/member/oauth/token`). Don't "REST-ify" paths the mobile app already uses.

### Anti-patterns from legacy — DO NOT replicate

- **No global static helpers** (`TB::`, `TBApi::instance`, `c::response`). Use injected services.
- **No "fat controller" that dispatches on a `$method` string** (`Controller_Api::member`). Each endpoint is its own `bindRoute`.
- **No mixed view + JSON returns** — backend is JSON only (admin EJS is the lone exception).
- **No `carr::get($x, 'key', $default)` style deep-null walking.** Validate DTO at the edge; trust the typed shape inside.
- **No SQL strings inline in controllers.** Prisma in service layer; `$queryRaw` only when a recursive CTE / window function is required (see `affiliate/utils/walk-inviter-chain.ts`).
- **No multi-tenant scoping (`org_id`, `network_account_id`)** — single-tenant.

---

## 5. Business Logic Rules

Critical rules surfaced from legacy that **must be preserved exactly** in the rewrite. Each line cites the legacy source so the rule can be re-verified.

- **Affiliate price recipient formula** (`TBAffiliator::getPriceRecipient`):
  `priceRecipient = floor((max(productPrice - voucherAmount, 0)) * rate / 100)`.
  Implemented at `src/modules/affiliate/utils/compute-amount.ts::computeAmount`.
- **PERFORMANCE tier thresholds** (`TBAffiliator::PERFORMANCE_SCHEMA_*`):
  - Tier 1 (≤5,000,000 IDR lifetime) → 20%
  - Tier 2 (≤15,000,000 IDR lifetime) → 30%
  - Tier 3 (>15,000,000 IDR lifetime) → 40%
  - Boundary is **inclusive** (`<=`). Off-by-one here = payout bug.
- **GROWTH multitier rates** (`TBAffiliator_Commision_CoursePayment::COMMISION_LEVEL_*`):
  L1=20%, L2=10%, L3=5%, L4=5%. Max depth = 4 levels.
- **GROWTH chain early-stop:** when walking inviter chain in GROWTH mode, stop as soon as an ancestor is `PERFORMANCE` (legacy `buildArrayRecipientMultitier`). Encoded in `walkInviterChain({ stopOnPerformance: true })`.
- **INACTIVE rate:** 20% (`TBAffiliator::INACTIVE_COMMISION_PERCENT`).
- **Voucher redeem = idempotent per order (NEW rule, implemented):** `VoucherService.redeem(voucherId, transactionId, paymentId?)` claims a per-order slot in the new `voucher_redemptions` table (unique `transaction_id`, no FK — mirrors `AffiliateAttributionClaim`) BEFORE the atomic `UPDATE vouchers SET used = used + 1` quota/window guard. A redelivered `commerce.payment.success` (Xendit webhook retry / event re-emit) re-hits the unique slot → P2002 → silent no-op, so `used` is never double-counted; if the increment later finds the voucher non-redeemable (`updated === 0`) it rolls back the claim then throws (invariant: a claim row ⇒ `used` was bumped). Distinct orders racing for the last quota slot still resolve to exactly one winner. Keyed on `transactionId` (one voucher per order), NOT paymentId — a re-purchase after refund is a NEW order and legitimately consumes another quota. Schema owner: `voucher_redemptions` table (migration `20260630120000_add_voucher_redemption`) lives here. The `OnCommercePaymentSuccess` listener passes `e.transactionId`/`e.paymentId`.
- **Free-trial voucher = time-boxed enrollment, not a discount (NEW rule, implemented 2026-08-20):** `vouchers.type='TRIAL'` + `vouchers.trial_days` grants course access for N days instead of money off. Only TWO columns are added repo-wide — `vouchers.trial_days` and `course_enrollment.via_voucher_id`; **`voucher_redemptions` is untouched**, so quota + per-order idempotency redeem through the exact same two-phase path as any other voucher. `computeTotals` handles TRIAL **explicitly** (100% off) — the AMOUNT fall-through would read `value` (0 on a trial row) and charge full price for a "free" trial; `amount=0` then settles through the existing `completeVoucherBypass()`, so no Xendit and no payment-code change (affiliate commission is already 0 there), and a normal `commerce_transactions` + `commerce_payments` row IS written. **Once-per-member is enforced on the ENROLLMENT, not a redemption row:** `course_enrollment` already carries `member_id`, and unlike a redemption it **survives expiry** — so `validate()` looks for any row with `viaVoucherId = voucher.id` for that product, deliberately WITHOUT filtering `expiredDate`/`isCanceled`, else a member re-trials every time the clock runs out. That is an app-level check (a unique index can't span tables), and the residual race cannot hand out two grants because `course_enrollment` is unique on `(member_id, course_id)` — it can only burn an extra `quota` slot. An earlier draft denormalised `member_id`+`is_trial` onto `voucher_redemptions` for a partial unique; dropped, because it needed a backfill + orphan `DELETE` on a production table to buy a guarantee the enrollment unique already gives. Scope is (voucher, product): a second trial code for the same course re-opens the trial — ops constraint, not a DB one. **`expired_date` is honoured ONLY for marked rows** — a retail/legacy row is valid by existence, since the legacy migration filled `expired_date` on lifetime purchases and the pre-trial gate never read it. That forced the single `ACTIVE_ENROLLMENT` const to split into TWO predicates (`packages/domain/src/commerce/enrollment.ts`): `activeEnrollment()` = "may consume content" (trial YES, and a **function** — `new Date()` in a module-level const freezes at boot) vs `OWNED_FOR_PURCHASE` = "already paid for" (trial NO), the latter used **only** by the checkout already-owned guard so a trial never blocks the sale it advertises. The `not_purchased` catalog shelf uses `activeEnrollment()` instead — a course the member can already open doesn't belong on a "belum dibeli" shelf; it returns to the shelf when the trial expires, and buying mid-trial still works, just not from that shelf. Expiry needs **no cron** (date-based predicate); conversion to a paid purchase updates the same row, clears the marker + date and **resets `progress` to 0** — which also erases the trial record, so a refund after conversion re-opens the trial (known, accepted). `validate()` returns `errorCode` so checkout can surface `VOUCHER_TRIAL_ALREADY_USED` instead of the generic `VOUCHER_INVALID`. **Outbound comms are trial-aware** (2026-08-20): a trial fires the same `commerce.payment.success`, so all three paths branch on `loadTrialGrant()` (`commerce/trial.ts`, shared by the enrollment/notification/email listeners — deliberately NOT an event field, since an optional field is read as "not a trial" by any emitter that forgets it and that failure is silent). Push/in-app uses new `ActionLabel.TrialStarted` ("Uji coba kamu aktif" / "Akses {produk} terbuka sampai {tanggal}.") — **no client release needed**, because payment notifications route on `refTable` (unchanged) and an unknown `type` falls to the default icon, which `paymentSuccess` already does; it is in `PUSH_LIMIT_EXEMPT` (transactional) and the date sits in the body because Android truncates titles at ~40 chars. Buyer email switches to bb-comms type `CourseTrialStarted` (own template, NO money block — every line would be Rp 0 or a discount equal to full price, reading as a bill for a purchase that never happened), and `SaleAlert` is **skipped** (a trial is not a sale). bb-comms derives the end date from `paid_at + vouchers.trial_days`, never from `course_enrollment.expired_date` (different async listener → race), and both repos format it in **WIB** (`formatDateWib`/`formatDateWIB`) because tz-less UTC storage shows the previous day after 17:00 WIB. **Deploy order is binding: bb-comms first** — an unknown message type goes straight to DLQ. Known gap: no pre-expiry reminder (needs cron + sent-marker; not built). Voucher authoring UI is in the **backoffice-bb** repo. Migration `20260820120000_voucher_trial`. Spec: `docs/commerce-port.md` §8b.
- **Attribution model:** last-touch overwrite, 30-day cookie window (`COOKIE_DAYS = 30`).
- **PENDING → BALANCE:** commissions move 7 days after payment (`PENDING_TO_BALANCE_DAYS = 7` — marketing-facing "5 hari kerja").
- **Withdrawable balance = single source of truth:** `withdrawableBalance = Σ(commission status=BALANCE) − Σ(disbursement status∈{PENDING,PROCESSING,PAID})` (`DisbursementService.getWithdrawableBalance`). Both `GET /affiliate/me/disbursement` (`withdrawableBalance`) AND the dashboard `GET /affiliate/me/summary` (`balance`) use this exact method, so they ALWAYS agree (summary used to show raw Σ BALANCE → overstated after a payout; fixed). `AffiliatorService` injects `DisbursementService` for it.
- **Disbursement min is runtime-configurable:** the minimum gross to request a payout lives in `app_settings.disbursement.minBalance` (key `SETTING_KEYS.disbursementMinBalance`, fallback `DISBURSEMENT_MIN_BALANCE`=15 000, seeded). `quoteDisbursement(balance, amount?, minBalance?)` takes it as a param; callers (`getSummary` + `requestDisbursement`) read the setting and pass it. `GET /affiliate/me/disbursement` returns it as `minBalance`. **Disbursement fee is also runtime-configurable:** `app_settings.disbursement.fee` (key `SETTING_KEYS.disbursementFee`, fallback `DISBURSEMENT_FEE`=5 000, seeded 5 000); `quoteDisbursement(balance, amount?, minBalance?, fee?)` takes it as a param, same two callers read+pass it. (`DISBURSEMENT_MIN_NET`=10 000 stays a constant.)
- **Affiliate code length:** member code = 6 chars, program code = 8 chars, alphabet `[A-Z0-9]`.
- **Member.legacyId:** Int, unique, **must be populated** when migrating users from legacy. Mobile app uses it as the primary identifier in some endpoints.
- **OAuth grant types** the mobile app sends: `password`, `social`, `client_credentials`, `refresh_token` (legacy `AuthService`). Refresh path is `POST /api/member/oauth/token` with `grant_type=refresh_token` — **not** `/oauth/refresh`. The `refreshTokenUrl` constant in the mobile client points at the unused path; don't be confused.

- **Refresh rotation is NOT instantly terminal — grace window + lineage (NEW rule, implemented 2026-08-03):** `refresh_tokens.superseded_by_id` (nullable, unique, plain scalar — **no FK**) holds the id of the row that replaced this one, and is written **ONLY by rotation**. That asymmetry is the whole safety argument: logout / password change / single-session kick revoke *without* a successor, so they stay terminal and instant, while a row retired by rotation stays replayable for `REFRESH_GRACE_SECONDS` (default 60, `env.jwt.refreshGraceSeconds`, boot-time — `0` disables). Fixes three false-logout classes: parallel refresh, **lost refresh response** (no app-kill needed — routine on ID mobile networks), and the **rotation tail** (in-flight requests on the pre-rotation access token). Branch order in `loginWithRefreshToken`: invalid → **grace replay** → `SESSION_REVOKED` → **expired** → rotate; grace is checked **before** expiry on purpose, else a row rotated near its own 30-day expiry answers `REFRESH_TOKEN_EXPIRED` while legitimately replayable. Grace replay creates **no row** (idempotent) and walks the `supersededById` chain up to `MAX_SUPERSESSION_HOPS`=5, because a client can be several generations behind. Concurrency gate = conditional `updateMany({where:{id, revokedAt:null}})` **inside an interactive tx**; loser blocks on the row lock, matches 0 rows under READ COMMITTED, throws internal `RotationLostError` → falls to grace replay. Two traps: the loser must re-read the row **after** the gate (earlier reads see `supersededById` null → 401, the exact bug being fixed), and the gate writes the pointer **before** the child row exists (hence no FK). `assertSessionActive` in `packages/common/src/middlewares/auth.middleware.ts` applies the same grace — required, since the rotation tail never reaches `AuthService`. Behaviour change is only ever 401→200; no new error codes, no response-shape change, **no client release needed**. NOT covered: silent social re-auth still kicks (`loginWithSocial` → `issueTokenBundle`; backend can't distinguish it from a second device without a `device_id`), RTR reuse-detection, and the `JWT_ACCESS_EXPIRES_IN` 7d→15m revert. Spec: `docs/refresh-token-grace.md`.
- **Notification title/body are always plain text (NEW rule, implemented 2026-08-04):** `NotificationProducer.create()` runs both through `toPlainText()` (`@bb/common/utils/plain-text.util`) before writing the row and before `dispatchPush`, so the stored row and the FCM payload can never disagree. The bug it fixes: `newPost` bodies come from `post.excerpt`, which is `content.slice(0, 200)` of raw editor HTML, so pushes reached the lock screen as literal `<p>p adu</p>` — Android/iOS render `body` verbatim and there is no client-side sanitiser. Titles interpolate `fullName`, user-controlled too. Normalising in the producer (not per listener) is deliberate: a listener that forgot would ship markup. `toPlainText` ≠ `sanitizeContent` (comment.service): that one guards what is **stored** (drops tags with no word boundary, keeps entities) because the client re-renders it; this one is for **display**, so block boundaries become a space, entities are decoded, whitespace collapses. Output provably contains no `<`/`>` — entities decode first, then any bracket they produced is replaced, so `&lt;script&gt;` can't decode back into markup. **`post.excerpt` itself is left as HTML** on purpose — it is exposed as `postContentData.excerpt` and rendered by the feed. Pre-existing rows are not backfilled (45/139 at the time of the change). Spec: `docs/notification-port.md` §Title/body.
- **Notification mute = push-only silencer (NEW rule, semantics changed 2026-08-04):** a mute on a `post`/`topic`/`network` withholds the **FCM push**; the `notifications` row is still written, unread, and counts toward `meta.unread`. Until 2026-08-04 listeners dropped muted members from the recipient list, so the history was destroyed and unmute could not restore it — a member who muted a busy topic could never catch up on it. Mechanism: listeners no longer filter recipients, they pass `muteScopes: Array<{scope, refId}>` into `CreateNotificationInput`; `NotificationProducer` resolves it to a per-member `pushMuted` via `RecipientResolver.mutedMemberIds` — `createForMany` asks **once per batch**, so the topic fan-out keeps its single mute query instead of going N+1. `filterNotMuted` was deleted rather than left unused: it returned a filtered recipient list, which is exactly the shape a new listener would reach for and reintroduce the bug with (`mutedMemberIds` returns a `Set`, useless for that). The `pushMuted` check sits **before** `claimPushSlot` on purpose — a push the member declined must not spend their unopened-push budget, else muting one noisy topic slowly throttles pushes from the topics they still follow. Commerce/transactional types bypass mute entirely (same list as `PUSH_LIMIT_EXEMPT`). No request/response shape changed → no client release. Known gap unchanged: `isMute` is readable only on `GET /topic/list`; nothing reports post/network mute state and there is no list-of-mutes endpoint. Spec: `docs/notification-mute-mobile.md` + `docs/notification-port.md` §Mute.
- **Network member list** edge: `/network/member` with empty `input` lists **all** members (mirrors legacy tag filter behavior — see commit `95a40c2`).
- **Media access (BunnyCDN):** course audio + video both live in one Bunny **Stream** library (id `157244`, CDN `vz-5439ef3e-878.b-cdn.net`) — there is no separate Storage zone. Bunny's only protection is referrer-gating (any `Referer` header → `200`), which is hotlink protection, **not** access control. The `media` module proxies MP4 renditions and the product serializer emits an opaque `streamUrl` token so `guid`/`videoLibraryId` never reach the client. Preview lessons (`isPreview`) stream without enrollment; non-preview requires `CourseEnrollment`. See `docs/media-port.md`.

- **HLS is the real Bunny output; MP4 is the fallback (NEW rule, probed 2026-08-11):** Bunny Stream transcodes every upload to an HLS ABR ladder — `/{guid}/playlist.m3u8` has always been live. MP4 (`play_{res}.mp4`) is the *extra* output `hasMP4Fallback` enables, and it is what Model B proxies. `GET /api/member/media/hls` returns the signed playlist URL **as JSON, not a `302`**: native offline downloaders (`AVAssetDownloadTask`, ExoPlayer `DownloadManager`) manage the fetch themselves and need a URL value, and iOS **cannot download progressive MP4 at all** — that, not the custom Dart crypto, is the root reason offline audio needs HLS. Directory token scoped `/{guid}/` means one URL covers every `.ts` segment; treat it as opaque. `download=true` picks `MEDIA_DOWNLOAD_TTL_SECONDS` (24 h) over `MEDIA_SIGNED_URL_TTL_SECONDS` (2 h) — the streaming TTL is deliberately NOT raised, since a signed URL needs no auth for its whole life. `expiresAt` is returned because an in-flight download **cannot** have its URL swapped (neither iOS nor ExoPlayer allows it) — expiry means cancel+restart, so the long TTL is the mitigation, not a refresh path. Gated on `MEDIA_MODE === 'signed'` → 404 `MEDIA_HLS_UNAVAILABLE`, because the `proxy`-mode library has token auth off and blocks empty referrers, and a native player sends no `Referer`. **The Model C cutover is therefore a hard prerequisite for offline playback.** Carries `mediaDownloadRateLimiter`: one signed URL exposes the whole asset, a bigger scrape surface than a single MP4. Still not DRM — segments sit unencrypted in the app sandbox (real protection = MediaCage Enterprise, $99/mo + license), and a downloaded asset is an OS bundle that **cannot be exported as a file**, so `/media/download` must stay if any "save to device" feature exists. Spec: `docs/media-port.md` §8.

- **Audio lessons are video, and the client must pin 360p (NEW rule, measured 2026-08-11):** Bunny has no audio-only mode, so an "audio" lesson is a video of a static image — `scripts/media-guids.json` counts **108 audio vs 70 video** of 178 assets, and every HLS variant carries `avc1` with no `#EXT-X-MEDIA:TYPE=AUDIO`. Measured: **360p and 480p carry byte-identical audio (134 kbps)**; 720p bumps it to 202 kbps, which is inaudible for spoken word. HLS costs ~45 % more than MP4 at the same rendition (61-min lesson: 87 MB vs 60 MB) — not because of the video track (the MP4 has one too, at 1.9 kbps) but because a **keyframe every 4 s** re-encodes the still image 920 times, landing at 64 kbps. HLS has no server-side default rendition, and left alone **iOS picks the top variant** = 157 MB for one hour of audio, so the client MUST pin 360p (`AVAssetDownloadTaskMinimumRequiredMediaBitrateKey` / `DownloadHelper.getTrackSelections()`). Trap: Bunny advertises peak `BANDWIDTH` (1.4/2.4/4.7 Mbps), ~7× the real average (198/222/359 kbps), and selection compares against the advertised number — "set 2 Mbps for quality" silently gets 480p. `MEDIA_DEFAULT_RESOLUTION` stays `720p` on purpose: it governs the MP4 path, where 70 assets are real video and 360p is a genuine downgrade.

- **KYC = Didit-driven disbursement gate (NEW provider for new KYC; legacy KYC IS real and migrated):** the new *flow* is **Didit** (switched from Sumsub 2026-06-26, reason = cost — Didit's ID+liveness+face-match workflow is effectively free; confirm free-tier in the Console), but legacy KYC is **not** absent — the `member_data_kyc` table (full KTP/NIK/selfie/bank submissions, ~5.7k members, actively reviewed by tribelio-admin via `actionby`/`actionat`) is the real source. `member.verification_kyc`/`last_kyc_status` are denormalised caches (and `last_kyc_status` is **stale** — trust `member_data_kyc`). The earlier "legacy had no real KYC" note was wrong: the writer lives in `tribelio-admin/` (out of jcodemunch index), not the tribelio app. Legacy KYC is migrated by `migrate:kyc` (APPROVED+REJECTED → `kycStatus`, `kycSource='LEGACY'`, `kycIdNumber=nik`, `kycReviewedAt`, `kycRejectedReason`; PENDING skipped). New `members.kyc_source` column = provenance of the current `kycStatus`: `NONE | LEGACY | MANUAL | DIDIT` (legacy-imported APPROVED members have no provider session + images in legacy S3). New flow: `POST /affiliate/me/kyc/token` creates a **Didit session** (`POST /v3/session/`, `vendor_data` = member UUID, session_id stored in `members.kyc_provider_ref`) and returns `{ sessionId, sessionToken, url, kycStatus }` — mobile launches the Didit SDK (`didit_sdk` Flutter / native) with `sessionToken` (or opens `url` in a webview); webhook `/api/webhook/didit` (HMAC-SHA256 raw-body `X-Signature` + `X-Timestamp` ±300s replay guard) drives `kycStatus`: `"In Review"`→PENDING, `"Approved"`→APPROVED / `"Declined"`→REJECTED. **Didit is session-per-attempt** (no persistent applicant): a webhook is only honoured when its `session_id == kyc_provider_ref` (the re-KYC safety net — see below). Disbursement still requires `kycStatus === 'APPROVED'` (legacy-APPROVED members pass). Manual `POST /affiliate/me/kyc` kept as fallback. **Min-balance gate (`assertBalanceForKyc`):** a member may only REQUEST KYC once their withdrawable balance reaches `app_settings.kyc.minBalance` (runtime-configurable via `SettingsService`, key `SETTING_KEYS.kycMinBalance`; fallback `KYC_MIN_BALANCE_DEFAULT=0`=off; seeded **55 000 IDR**). Enforced in BOTH `createDiditSession` and `submitKyc` (no manual bypass), uniformly across NONE/PENDING/REJECTED/EXPIRED → `400 'Saldo belum mencukupi untuk verifikasi KYC'`. Schema change: `members.sumsub_applicant_id` → `kyc_provider_ref` (migration `20260626120000_rename_kyc_provider_ref`). Spec: `docs/kyc-didit.md` (+ `docs/kyc-didit-mobile.md`).

- **KYC document number is captured at PENDING, not at approval (NEW rule, implemented 2026-08-26):** the Didit status webhook carries no document number, so `markDiditPending` pulls `getSessionDecision(sessionId)` and `extractDocumentIdentity()` writes `members.kyc_id_number` + the new `members.kyc_id_type`. Writing it on the PENDING transition rather than on `applyDiditReview(approved)` is the load-bearing choice: **the approve/reject decision is normally taken by an admin in the backoffice**, and that path writes `members.kyc_*` straight over SQL (`backoffice-bb/lib/kyc-queries.ts::setKycDecision`) without re-entering `DisbursementService` at all — an approval-time write would miss the common case entirely, which is exactly the bug being fixed (Didit-verified members had an empty `kyc_id_number` while manual/legacy members kept theirs, so the column looked random). The reviewer also needs the number **before** deciding. `applyDiditReview` keeps a second write on `approved` as a safety net for a missed PENDING webhook, but that is NOT a repair path: the `kycStatus === newStatus` early-return fires first, so a replay can never fill a gap — hence the one-shot `pnpm kyc:backfill-didit-id [--dry-run]`. **`kyc_source` is not a valid "went through Didit" filter**: a backoffice decision rewrites it to `MANUAL` while leaving `kyc_provider_ref` intact, so both the backfill and any ops query key on **`kyc_provider_ref IS NOT NULL`** (a member whose ref was cleared by a re-KYC reset is unbackfillable by construction and fills in on the next attempt). Field preference is `document_number` → `personal_number`, because on an Indonesian KTP the document number IS the NIK while `personal_number` is the optional MRZ field. Three fail-safes, all "leave the stored value alone": a decision with no `id_verifications` (liveness-only workflow), a missing number, and an unreachable Didit all resolve to an empty partial spread — a provider blank can never wipe a number captured manually or migrated from legacy — and the pull is wrapped so a Didit outage still applies the status transition instead of answering non-2xx and earning a retry storm. `kyc_id_type` is stored **verbatim** as Didit labels it (`Identity Card`, `Passport`, …) — a `KTP|SIM|PASSPORT` enum would guess at strings not yet observed from every workflow. The number itself is never logged, only the field it came from. Prerequisite: the published workflow must contain an ID-document step. Migration `20260826120000_add_kyc_id_type`. Spec: `docs/kyc-didit.md` §Document number.

- **Re-KYC = APPROVED revoked on a risk event (NEW rule, implemented):** an APPROVED affiliate is forced to re-verify before the next payout when one of four events fires. New status value `kycStatus='EXPIRED'` (free-form string, no DB enum → no members DDL) = "was approved, must re-KYC"; the disbursement gate only passes `APPROVED`, so EXPIRED is blocked (message `'KYC perlu diperbarui'`). `DisbursementService.resetKyc(memberId, reason, opts)` is the single entry point — no-op unless currently APPROVED, preserves `kycSource`, writes a `kyc_event` audit row, and **clears `kyc_provider_ref`** so a stale `"Approved"` webhook from the old session can't auto-re-approve (Didit is session-per-attempt → no applicant to reset; the webhook handlers also ignore any event whose `session_id != kyc_provider_ref`, and re-KYC mints a fresh session). DB-only, no provider call. Triggers: ① **bank change** in `setBankAccount` (only when an EXISTING account changes, not first-time setup); ② **large disbursement** in `requestDisbursement` (`netAmount >= REKYC_LARGE_DISBURSEMENT_IDR`=5,000,000 AND last review older than `REKYC_STALE_DAYS`=180 → aborts the tx via `ReKycRequiredError`, then resets); ③ **dormant reactivation** in `MemberService.findById` (reuses existing `members.last_active_at`, gap > `REKYC_DORMANT_DAYS`=365; no new column, no cron); ④ **suspicious** = admin calls `resetKyc(reason='SUSPICIOUS')`. New `kyc_event` table is an append-only AML trail (RESET/SUBMIT/PENDING/APPROVE/REJECT, lifecycle events guarded by a real transition so webhook replays stay idempotent). Thresholds in `env.rekyc.*`. Spec: `docs/kyc-rekyc.md`.

- **Register = inactive-until-verified (NEW rule, not legacy):** both register paths create members `isActive=false`; the verify-OTP step (`validateOtpPhone` / `validateOtpEmail`) activates. A row with `legacyId=null && isActive=false && isEmailVerified=false && isPhoneVerified=false && scheduledDeletionAt=null` is a **reusable placeholder** (`legacyId!=null` = migrated legacy account, never reusable): re-registering the same email/phone overwrites it (predicate `isReusableUnverifiedMember` in `packages/common/src/utils/member-state.util.ts`). Password login on a placeholder → generic 401 (a `403 ACCOUNT_NOT_VERIFIED` discriminator exists in `loginWithPassword` but is commented out). `/auth/register` no longer returns tokens. Full spec: `docs/register-verification-flow.md`.

- **Social link gate = provenance-based (NEW rule, implemented 2026-07-30):** the social link path (existing local account matched by email, no provider sub yet) allows the link when the row is EITHER already `isEmailVerified` OR legacy-migrated (`legacyId != null`); a new-flow unverified row still gets `400 EMAIL_IN_USE_UNVERIFIED`. Reason for keeping the block on new-flow rows = **account pre-hijacking**: a register placeholder may hold an attacker-chosen password, and linking would leave that attacker with permanent password access to the real email owner's account (affiliate balance + payout bank). Reason legacy is exempt: `is_email_verified=0` carries **no information** on legacy rows — legacy had no OTP gate and the only writer of that column is `tribelio-admin`'s manual-create path, so the provider attestation is the row's first real proof of ownership. `legacyId` is unwritable from the API surface → the exemption can't be forged. Single entry point `AuthService.linkSocialToExistingMember` (shared by the link path AND the unique-violation retry path, which previously skipped the `isActive` check). On the heal branch it ALSO revokes every live refresh token (`issueTokenBundle` only clears the mobile bucket — web is multi-session) and re-levels `legacy_synced_at = updated_at` via `preserveLegacyResyncGate` so the resync touch-gate (`updatedAt > legacySyncedAt`) stays untripped and legacy `fullName`/`avatar`/`bio` keep flowing. Side effect to remember: flipping `isEmailVerified` **locks the email** (`EMAIL_LOCKED_AFTER_VERIFICATION` in `profile.service.ts`). NOT covered: legacy rows with `email` NULL / mismatched still create a **duplicate account** via the create path. Spec: `docs/register-verification-flow.md` #5.

- **OTP resend cooldown = decoupled from TTL (NEW rule, implemented 2026-07-30):** TTL and resend cooldown used to be one number — `enforceResendGuard` checked `expiresAt > now`, so a `forgot-password` resend waited the full 10-minute TTL. Now **TTL is unchanged** (`DEFAULT_TTL`: 1m delete-account, 2m verify-phone, 10m forgot-password/verify-email, 15m pre-registration) and cooldown is its own knob: `OTP_RESEND_COOLDOWN_SECONDS`=60, measured from the previous row's **`createdAt`** and NOT lifted by consuming the code (what is throttled is the outbound message). Send cap moved from a server-local calendar day to a **rolling 24h**, defaulting by channel (`OTP_MAX_PER_DAY` = WhatsApp 5 / email 10 — WA is billed per message). Both knobs are **opt-OUT**, because four of the eight send endpoints had shipped with no throttle at all; pass `0` to disable (tests only). `issue()` now **supersedes** every live row for the target+purpose (sets `usedAt`) in the same transaction — required, not cosmetic: two live codes are the normal case under a short cooldown, and `resolveAndMatch` only reads the newest, so the older row became reachable again the moment the newest locked out, handing over a fresh `MAX_OTP_ATTEMPTS` budget. A code matching a recently retired row returns `OTP_EXPIRED` **without charging an attempt** (`matchesSupersededCode`). `issueOrReuse()` is the variant for endpoints that mutate state before sending (`register`, `registerByPhone` — both overwrite an unverified placeholder, so a 400 would strand the client); every pure-send endpoint keeps `issue()`. New rate limiters closed two unprotected routes: `/account/preRegistration` (was **unauthenticated with no throttle at all** and mails any posted address — an open mailbomb relay) and `/account/requestDeleteAccount`. Both throttle errors now carry `retryAfterSeconds`. Spec: `docs/otp-cooldown.md` (incl. known-unchanged: `/auth/validateOtp` uses `verify()` so its code is replayable within TTL; `otp_codes` has no prune job).

- **Tester account fixed-OTP bypass (NEW rule, for app-store review):** a whitelisted tester identifier (email/phone) satisfies any OTP with the fixed code **`000000`** — a real OTP can never be `000000` (`randomInt(100000,1000000)`). Centralised in `OtpService` (`packages/common/src/services/otp.service.ts`): `issue()` skips row creation + comms delivery (also dodges resend-guard/daily-cap); `verify()`/`consume()` accept the fixed code with no bcrypt/expiry check. Config read **live** via `testAccountConfig()` in `config/env.ts` (`TEST_ACCOUNT_ENABLED` default OFF, `TEST_ACCOUNT_OTP_CODE`, `TEST_ACCOUNT_IDENTIFIERS`). Must work in **prod** (App Review hits prod) — secured by the kill-switch + exact-match whitelist. Whitelist dummy accounts ONLY (a real identifier here = password reset via forgot-password). Seed the member with `pnpm seed:test-account`. Spec: `docs/test-account.md`.

- **Legacy resync = incremental transition-period sync (NEW, implemented):** during cutover legacy MariaDB is still written to, so already-migrated data is kept fresh by an incremental sync (NOT re-running `migrate:*`, which are insert-only `createMany`). Every legacy table has a Cresenity `updated` column → all syncers are **incremental** (`WHERE COALESCE(updated,created) > watermark`), catching inserts+edits+soft-deletes in one pass (residual gaps, logged: post/comment hard-deletes filtered by `status=1/is_active=1`, and un-likes = hard `DELETE` of a `like` row). 7 syncers in dependency order: **members → enrollments → kyc → tree → commissions → reviews → posts** (posts covers comments/replies/likes). Per-syncer watermark + stats in new `sync_state` table; dedup map moved from `scripts/member-redirect.json` to durable `member_redirect` table; run-lock is a TTL `__lock__` row in `sync_state` (not pg advisory lock). **members = new-wins-on-touch:** only `legacyId!=null` winners touched, only profile fields (`fullName/avatarUrl/bio/isActive`) overwritten, gated by `updatedAt <= legacySyncedAt` (a raw UPDATE sets both `updated_at` and `legacy_synced_at` to the same app-side `Date` param — NOT server `now()`, columns are tz-less `timestamp` filled with app-clock UTC everywhere else — so an app write trips the gate); legacy deactivation always propagates. **commissions** only ever touch `status=MIGRATED` (new Xendit rows have `legacyId=null`, no collision); `is_expired=1`→`VOIDED`. **kyc** guard `kycSource IN (NONE,LEGACY)`. Run from repo root: `pnpm resync [syncer...] [--dry-run] [--since=]` (one-shot CLI) or `pnpm resync:worker` (loop, interval = env `RESYNC_INTERVAL_SEC` default 3600, all syncers each tick); also `resync:seed-redirect` (import `scripts/member-redirect.json` → `member_redirect` table, once) and `resync:unlock` (clear a stale run-lock). **Code lives in `apps/resync-worker/`** (throwaway transition tool, retired after cutover — delete the app dir + the four `resync*` root scripts). Uses root `@prisma/client` + `@bb/common/utils/phone.util` directly (NO schema/util copy → no drift; this is why it was folded back in from the old standalone `bb-legacy-resync` repo, now archived). Resilient legacy connection: reconnects + retries on `ECONNRESET` up to `RESYNC_LEGACY_RECONNECT_RETRIES` (default 3). **Perf + run-to-run safety (2026-07-09):** all write loops are concurrent (`runConcurrent`, env `RESYNC_WRITE_CONCURRENCY` default 10; `ensureMember` in-flight memo prevents double-creates, pair-keyed tables claim their pair map synchronously); stored watermarks get an overlap re-scan (`RESYNC_WATERMARK_LAG_SEC` default 60 — legacy `updated` is set at PHP save() but visible at COMMIT); run-lock is heartbeat-refreshed per syncer (long run > TTL can't be taken over mid-write); end-of-run **backfill pass** re-scans kyc/tree/commissions/likes since epoch for members materialised on demand that run (their old legacy rows are behind the other watermarks forever otherwise). **Community auto-join (2026-07-31):** that same pass also joins those members to both BB community networks (`purpose` timeline+education) — a resync-created member never passes `AuthService.autoJoinCommunityNetworks`, so without it they have NO `NetworkMember` row and every write path (post/comment/like) 403s `NETWORK_MEMBERSHIP_REQUIRED` (feed reads still work — both networks are public); `recountCounters` now rebuilds `networks.count_member` too, and the existing stock is fixed by re-running the idempotent `scripts/migrate-network-members.ts`. **Timezone:** legacy DATETIMEs are WIB wall-clock — the mysql2 conn (`timezone:'+07:00'`) converts both directions, so Postgres stores UTC (= legacy −7h); rows written pre-fix (before 2026-07-08) need one `pnpm resync:fix-dates` (covers members/enrollments/commissions/reviews/likes; posts+comments self-heal via upsert-update) — STILL PENDING on bb_backend, run it once after the in-flight first run finishes. Spec (design + business rules): `docs/legacy-resync-plan.md`.

- **`passwordAlgo` is derived from the hash shape, never assumed (NEW rule, fixed 2026-08-21):** every legacy→new member writer used to stamp `passwordAlgo: legacyPassword ? 'legacy' : 'social'` blind. `'legacy'` is the **md5 alias** in `AuthService.verifyPassword`, so a member whose legacy hash is bcrypt gets `md5(plaintext)` compared against `$2y$…` — never a match, **permanent lockout with the correct password**, and no error to distinguish it from a wrong password. Measured on live legacy (710k rows): 462,059 md5 / 248,328 NULL / **440 bcrypt** (`$2y$10$`, 60 chars) — legacy writes md5 in every visible path (`TBMember.php:1053`, `tribelio-admin/member.php:252`), the bcrypt rows are the exception, and 57 had already landed in Postgres mis-stamped. `detectPasswordAlgo(hash)` (`@bb/common/utils/password-algo.util`) maps shape → algo: `$2[aby]$NN$`→`bcrypt`, 40 hex→`sha1`, 64 hex→`sha256`, else (md5 + unknown)→`legacy`, null/empty→`social`. Wired into all four creators (`ensure-member.ts`, `identity.ts`, `scripts/migrate-members.ts`, `scripts/migrate-from-legacy.ts`) + the members syncer. **The members syncer now also propagates `password_hash`/`password_algo`** under the existing touch-gate — legacy still takes resets during cutover, and a new-app change-password or the lazy md5→bcrypt rehash bumps `updatedAt` so new wins from then on; a NULL legacy password is a `COALESCE` no-op so a real hash is never clobbered by the social sentinel. Existing rows repaired once by `pnpm resync:fix-password-algo [--dry-run]`, which deliberately does NOT bump `updated_at` (that would trip the touch-gate and freeze the profile against legacy forever) and skips `social` rows outright. Spec: `docs/legacy-resync-plan.md` §6.1.

- **App update gate = BE is sole source of truth (NEW rule, not legacy, implemented 2026-08-03):** `GET /api/app/version-check?platform=&version=&build=` replaces BOTH gates the app used to run (scraping the store listing via `new_version_plus`, and the Supabase table `mobile_version_config` — FE deletes the Supabase dependency in the 3.2.3 patch). Config = **one row per platform** in `app_version_configs` (`platform` PK ∈ {android, ios}); verdict `version < force_below → force`, else `version < latest_version → soft`, else `none`, both comparisons **strict `<`**, numeric per-segment semver (`3.10.0 > 3.9.9` — a string compare gets this wrong). Rows are per-platform because Play staged rollout and App Store review never land together, and iOS has a constraint Android doesn't (`force_below` must stay below the build in Apple review or the reviewer meets a non-dismissible dialog → rejection). **Route is PUBLIC and must never answer 401** — the mobile interceptor attaches whatever bearer it holds, including an expired one, and a 401 on a version ping would trigger a token refresh / forced logout; there is no `authGuard` on it at all. Fail-safe everywhere: missing config row → `none` (`latestVersion: null`), unparseable `version` → `none` (a malformed string from an old build must never trap a user behind a force dialog), unknown `platform` → 400. `soft_message`/`force_message` are stored separately but returned as one `message` (client renders one body copy). Config is cached ~60s in-process, so an ops SQL edit — in particular clearing `force_below` as a kill-switch — lands within a minute with no redeploy. Since the store-scrape gate is gone, the table is the only thing between a typo and a fleet-wide lockout, hence DB `CHECK` constraints: platform enum, both version columns `^[0-9]+\.[0-9]+\.[0-9]+$`, and `force_below <= latest_version` compared as `int[]`. Bootstrap `pnpm seed:app-version` (insert-only, force disabled). Ops runbook + FE contract: `docs/app-version-check-contract.md`.

- **RevenueCat `app_user_id` is not always a member UUID (NEW rule, fixed 2026-08-04):** it only carries `Member.id` after the app calls `Purchases.logIn()` — a purchase made before that (or after reinstall/logout) arrives as `$RCAnonymousID:<hex>`. `RevenueCatWebhookHandler.memberRef()` resolves ① first UUID among `app_user_id` → `original_app_user_id` → `aliases` (RC backfills `aliases` with the real id when the SDK aliases the anonymous customer later), then ② `subscriber_attributes.$email.value` → `byEmail`. Anonymous ids are **dropped, never forwarded as `byId`** — `members.id` is `@db.Uuid`, so `findUnique({where:{id:'$RCAnonymousID:…'}})` throws Prisma **P2023**, which `errorHandler` maps to **400**; RC then exhausts its retries and the event is lost for good (member paid, no access), and the `$email` fallback that was already coded in `resolveMember` never ran because the throw came first. `isUuid()` now guards both `resolveMember` and `resolveProduct` in `purchaseIngestService`, so every ingest channel is covered, not just RC. Unresolvable events return `member_not_found` and log at **warn** — the response stays 200, so that log line is the only alertable signal for a paid-but-ungranted purchase. Spec: `docs/revenuecat-webhook-port.md` §Member resolution.

For complete rule extraction per module, see `docs/legacy-analysis.md`.

---

## 6. Testing Requirements

- **Unit tests:** every rewritten module needs at least one `*.spec.ts` covering service-level business logic. Pure utility functions (e.g. `computeAmount`, `getPerformanceTier`) get table-driven tests.
- **Integration tests required for:** `auth`, `account` (change-password, logout), `product` (purchase / detail), `affiliate` (visit logging, commission compute), `network` (join flow), `commission`, `upload`.
- **Smoke tests:** keep `tests/api-smoke.spec.ts` + `tests/swagger-smoke.spec.ts` green — they assert every registered route resolves and every OpenAPI schema serializes.
- **Naming:**
  - File: `<feature>.spec.ts` (integration) or `<feature>-<thing>.spec.ts` (focused).
  - `describe('AffiliateService.computeAmount', () => { it('clamps voucher above price to zero', ...) })`. State the expectation, not the implementation.
- **DB in tests:** integration tests must hit a real Postgres (see memory `[[feedback_tooling]]` — no Docker for local Postgres; use the host service). **No mocking the database.**
- **Run:** `pnpm test` (one-shot) / `pnpm test:watch`.

---

## 7. Rewrite Progress Tracking

- [x] **monorepo extraction** (ADR-0001) — pnpm workspace: `packages/{db,common,domain}` + `apps/{mobile-api,backoffice-api,admin-ejs}`. All 238 tests green on new layout. Repo rename to `bb-platform` deferred.

Module status (one-line summary; details in `docs/rewrite-progress.md`):

- [x] auth — OAuth/JWT, register, forgot-password, devices, refresh grace window + supersession lineage (`docs/refresh-token-grace.md`)
- [x] account — profile, change-password, logout, pre-registration, delete-account
- [x] member — info, list
- [x] profile — view, update
- [x] location — country/province/city/district
- [x] upload — multipart → S3 (sharp webp re-encode + resize + EXIF strip; `public/*` CDN, `private/*` presigned-ready). Replaces local disk + `/static/temporary`. See `docs/upload-s3-port.md`
- [x] banner — list
- [x] product — course detail (legacy parity — see `feat/base-update`)
- [x] media — BunnyCDN Stream MP4 proxy; opaque token hides `guid`/`library_id`; preview-free / enrollment-gated. Integration tests pending host Postgres
- [x] commission — list (read-only)
- [~] affiliate — program, attribution, visit logging done; payout compute pending parity tests
- [x] topic — CRUD
- [x] post — feed, CRUD
- [x] comment — CRUD
- [x] reply — minimal
- [x] network — CRUD, member list (empty-input lists-all parity)
- [x] notification — list, read, producer (commerce/post/comment/like/network), FCM v1 push (fire-and-forget), mute. Pending: FCM live credentials + manual push QA. RabbitMQ outbox deferred (see `docs/notification-port.md §12`).
- [x] report — submit
- [x] app-version — public `GET /api/app/version-check` force/soft update verdict; replaces the app's Supabase `mobile_version_config` + store-listing scrape. See `docs/app-version-check-contract.md`
- [x] admin — was done (EJS internal sysadmin), but `apps/admin-ejs` REMOVED 2026-07 (recover from git history if needed)
- [x] commerce / purchase — Xendit-only (CC + VA + eWallet), 2-step checkout→payment, voucher bypass, webhook + cron expire, event-driven side effects (enrollment + affiliate commission + voucher redeem). See `docs/commerce-port.md`. Pending: manual Xendit sandbox QA
- [ ] backoffice — `apps/backoffice-api` scaffold REMOVED 2026-07 (was never started). Plan docs kept: `docs/backoffice-port-plan.md` + `docs/backoffice-port/`
- [~] disbursement — bank payout flow COMPLETE in `@bb/domain` (request AUTO/MANUAL + `disburseViaXendit` + webhook `/api/webhook/xendit/disbursement` + job `executeApprovedDisbursements` sweeps backoffice-approved rows & re-checks KYC at execution). Approval UI = **backoffice-bb repo** (`/disbursements`, perms `disbursements.view/manage`; approve = stamp `approved_at` via SQL only — Xendit key & state machine stay here). Legacy is bank-ONLY (e-wallet payout never existed — `TBBank` has no wallet entries; OVO/GoPay refs are payment-IN); e-wallet payout = new product decision (Payouts v2), not parity. Pending: legacy bank backfill (`bank_account_bank` lowercase keys → Xendit codes; `mandiri-syariah`→BSI), Xendit env keys + dashboard callback URL, sandbox QA
- [ ] chat / broadcast — drop or defer
- [ ] certificate — drop or defer
- [ ] cron / queue — drop (use Postgres LISTEN or external scheduler later)
- [x] logging / request tracing — pino + `AsyncLocalStorage` correlation (`requestId` on every line, no service refactor), `requestLogger` access log replacing morgan, `route`/`handler` tagging via `bindRoute`, `userId` via auth guards, `service.call` spans via `traceService()` at the route boundary, Prisma → pino bridge (`db.op` correlated / `db.query` raw SQL), deep body/query redaction. Pending: log shipping + alerts (CloudWatch metric filters), worker-side context. See `docs/logging.md`
- [x] legacy resync — incremental transition-period sync (7 syncers, watermark/lock/new-wins, on-demand new-member create+dedup, resilient legacy reconnect). Built + validated on bb_trial (errors=0). **Code in `apps/resync-worker/`** (throwaway; folded back in from the old standalone repo so it shares root `@prisma/client` + `@bb/common` → no drift). See `docs/legacy-resync-plan.md`

Detailed per-module status, blockers, and outstanding parity items: `docs/rewrite-progress.md`.

---

## 8. Session Rules

- **`/clear` between modules.** Don't carry stale context across feature areas.
- **Save discoveries to `docs/`** before clearing — anything non-obvious about legacy semantics, edge cases, or undocumented mobile-client expectations goes into `docs/legacy-analysis.md` (or a new `docs/<feature>.md` if it's large).
- **`index_file {path}`** on every file you edit, before ending the session. If you renamed/moved files, rerun `index_folder` for the new tree.
- **Plan-mode for non-trivial work:** if a task touches ≥3 files or introduces a new module, present a plan via `ExitPlanMode` before coding.
- **Auto-memory:** save user/feedback/project/reference memories per the rules in this CLAUDE.md's auto-memory section. Don't save code patterns / file paths / commit messages — those live in the code and git log.
- **End each session with:** "Update CLAUDE.md and docs/ with anything new discovered this session." Then act on it: append new business rules under §5, new dead-code findings to `docs/legacy-analysis.md`, and bump module status in `docs/rewrite-progress.md`.

---

## Quick reference

- Run dev: `pnpm dev`
- Run tests: `pnpm test`
- Prisma migrate: `pnpm prisma:migrate`
- Seed admin: `pnpm seed:admin`
- Trigger topic digest manually (QA): `pnpm digest:run [--member=<uuid|email>] [--send]` — dry-run by default; forces past `digestEnabled` + the hour gate. A real run stamps `last_topic_digest_at`, consuming that night's scheduled digest.
- Migrate from legacy DB: `pnpm migrate:legacy` (script at `scripts/migrate-from-legacy.ts`)
- Repair `members.password_algo` after a legacy import: `pnpm resync:fix-password-algo [--dry-run]`
- Swagger UI: `http://localhost:<port>/api/docs`
- New repo jcodemunch ID: `devtribelio/new-brainboost-backend`
- Legacy repo jcodemunch ID: `tribelio-platform`
