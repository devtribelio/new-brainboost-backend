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

### Already decided

- **Module-per-feature** under `src/modules/<feature>/`. Each module exports an `AppModule` (`name`, `prefix`, `routes()`).
- **Routing:** `bindRoute({ router, controller, method, path, handlerKey, middlewares })` from `src/common/openapi/route-binder.ts`. This registers the Express route AND the OpenAPI entry in one call. Always use `bindRoute` — never `router.post(...)` directly.
- **DI:** manual instantiation in `*.routes.ts` (`new Controller(new Service())`). No tsyringe (see memory `[[feedback_di]]`).
- **Validation:** DTOs use `class-validator` decorators. `validateDto(Dto)` middleware transforms + validates `req.body` (or `req.query` with the `'query'` source variant).
- **Auth:** `authGuard` middleware reads `Authorization: Bearer <jwt>` and attaches `AuthenticatedUser` to `req.user`. Routes that need auth list `authGuard` first in `middlewares`.
- **Responses:** use `ok(res, data, meta?)` / `okCreated(res, data, meta?)` / `okPaginated(res, items, {page,perPage,total}, extraMeta?)` / `fail(res, status, code, message, details?)` from `src/common/utils/response.util.ts`. Standard envelope: `{ success: boolean, data, meta, error }`. Pagination metadata lives at `meta.pagination = { page, perPage, total, totalPages }`. See `docs/api-envelope.md` for the full spec.
- **Exceptions:** throw `BadRequestException` / `UnauthorizedException` / `ForbiddenException` / `NotFoundException`. `errorHandler` middleware maps them to `{ success:false, error:{ code, message, details? } }`. Default error codes: `BAD_REQUEST`, `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `INTERNAL_ERROR`.
- **IDs:** UUID v7 (`@default(uuid(7)) @db.Uuid`) repo-wide. **`legacyId Int? @unique`** on every entity that maps to legacy — the mobile app still passes int IDs (see memory `[[project_rewrite_context]]`).
- **Logger:** `pino` (`src/config/logger.ts`). Don't `console.log`.
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
- **Attribution model:** last-touch overwrite, 30-day cookie window (`COOKIE_DAYS = 30`).
- **PENDING → BALANCE:** commissions move 7 days after payment (`PENDING_TO_BALANCE_DAYS = 7` — marketing-facing "5 hari kerja").
- **Withdrawable balance = single source of truth:** `withdrawableBalance = Σ(commission status=BALANCE) − Σ(disbursement status∈{PENDING,PROCESSING,PAID})` (`DisbursementService.getWithdrawableBalance`). Both `GET /affiliate/me/disbursement` (`withdrawableBalance`) AND the dashboard `GET /affiliate/me/summary` (`balance`) use this exact method, so they ALWAYS agree (summary used to show raw Σ BALANCE → overstated after a payout; fixed). `AffiliatorService` injects `DisbursementService` for it.
- **Disbursement min is runtime-configurable:** the minimum gross to request a payout lives in `app_settings.disbursement.minBalance` (key `SETTING_KEYS.disbursementMinBalance`, fallback `DISBURSEMENT_MIN_BALANCE`=15 000, seeded). `quoteDisbursement(balance, amount?, minBalance?)` takes it as a param; callers (`getSummary` + `requestDisbursement`) read the setting and pass it. `GET /affiliate/me/disbursement` returns it as `minBalance`. **Disbursement fee is also runtime-configurable:** `app_settings.disbursement.fee` (key `SETTING_KEYS.disbursementFee`, fallback `DISBURSEMENT_FEE`=5 000, seeded 5 000); `quoteDisbursement(balance, amount?, minBalance?, fee?)` takes it as a param, same two callers read+pass it. (`DISBURSEMENT_MIN_NET`=10 000 stays a constant.)
- **Affiliate code length:** member code = 6 chars, program code = 8 chars, alphabet `[A-Z0-9]`.
- **Member.legacyId:** Int, unique, **must be populated** when migrating users from legacy. Mobile app uses it as the primary identifier in some endpoints.
- **OAuth grant types** the mobile app sends: `password`, `social`, `client_credentials`, `refresh_token` (legacy `AuthService`). Refresh path is `POST /api/member/oauth/token` with `grant_type=refresh_token` — **not** `/oauth/refresh`. The `refreshTokenUrl` constant in the mobile client points at the unused path; don't be confused.
- **Network member list** edge: `/network/member` with empty `input` lists **all** members (mirrors legacy tag filter behavior — see commit `95a40c2`).
- **Media access (BunnyCDN):** course audio + video both live in one Bunny **Stream** library (id `157244`, CDN `vz-5439ef3e-878.b-cdn.net`) — there is no separate Storage zone. Bunny's only protection is referrer-gating (any `Referer` header → `200`), which is hotlink protection, **not** access control. The `media` module proxies MP4 renditions and the product serializer emits an opaque `streamUrl` token so `guid`/`videoLibraryId` never reach the client. Preview lessons (`isPreview`) stream without enrollment; non-preview requires `CourseEnrollment`. See `docs/media-port.md`.

- **KYC = Didit-driven disbursement gate (NEW provider for new KYC; legacy KYC IS real and migrated):** the new *flow* is **Didit** (switched from Sumsub 2026-06-26, reason = cost — Didit's ID+liveness+face-match workflow is effectively free; confirm free-tier in the Console), but legacy KYC is **not** absent — the `member_data_kyc` table (full KTP/NIK/selfie/bank submissions, ~5.7k members, actively reviewed by tribelio-admin via `actionby`/`actionat`) is the real source. `member.verification_kyc`/`last_kyc_status` are denormalised caches (and `last_kyc_status` is **stale** — trust `member_data_kyc`). The earlier "legacy had no real KYC" note was wrong: the writer lives in `tribelio-admin/` (out of jcodemunch index), not the tribelio app. Legacy KYC is migrated by `migrate:kyc` (APPROVED+REJECTED → `kycStatus`, `kycSource='LEGACY'`, `kycIdNumber=nik`, `kycReviewedAt`, `kycRejectedReason`; PENDING skipped). New `members.kyc_source` column = provenance of the current `kycStatus`: `NONE | LEGACY | MANUAL | DIDIT` (legacy-imported APPROVED members have no provider session + images in legacy S3). New flow: `POST /affiliate/me/kyc/token` creates a **Didit session** (`POST /v3/session/`, `vendor_data` = member UUID, session_id stored in `members.kyc_provider_ref`) and returns `{ sessionId, sessionToken, url, kycStatus }` — mobile launches the Didit SDK (`didit_sdk` Flutter / native) with `sessionToken` (or opens `url` in a webview); webhook `/api/webhook/didit` (HMAC-SHA256 raw-body `X-Signature` + `X-Timestamp` ±300s replay guard) drives `kycStatus`: `"In Review"`→PENDING, `"Approved"`→APPROVED / `"Declined"`→REJECTED. **Didit is session-per-attempt** (no persistent applicant): a webhook is only honoured when its `session_id == kyc_provider_ref` (the re-KYC safety net — see below). Disbursement still requires `kycStatus === 'APPROVED'` (legacy-APPROVED members pass). Manual `POST /affiliate/me/kyc` kept as fallback. **Min-balance gate (`assertBalanceForKyc`):** a member may only REQUEST KYC once their withdrawable balance reaches `app_settings.kyc.minBalance` (runtime-configurable via `SettingsService`, key `SETTING_KEYS.kycMinBalance`; fallback `KYC_MIN_BALANCE_DEFAULT=0`=off; seeded **55 000 IDR**). Enforced in BOTH `createDiditSession` and `submitKyc` (no manual bypass), uniformly across NONE/PENDING/REJECTED/EXPIRED → `400 'Saldo belum mencukupi untuk verifikasi KYC'`. Schema change: `members.sumsub_applicant_id` → `kyc_provider_ref` (migration `20260626120000_rename_kyc_provider_ref`). Spec: `docs/kyc-didit.md` (+ `docs/kyc-didit-mobile.md`).

- **Re-KYC = APPROVED revoked on a risk event (NEW rule, implemented):** an APPROVED affiliate is forced to re-verify before the next payout when one of four events fires. New status value `kycStatus='EXPIRED'` (free-form string, no DB enum → no members DDL) = "was approved, must re-KYC"; the disbursement gate only passes `APPROVED`, so EXPIRED is blocked (message `'KYC perlu diperbarui'`). `DisbursementService.resetKyc(memberId, reason, opts)` is the single entry point — no-op unless currently APPROVED, preserves `kycSource`, writes a `kyc_event` audit row, and **clears `kyc_provider_ref`** so a stale `"Approved"` webhook from the old session can't auto-re-approve (Didit is session-per-attempt → no applicant to reset; the webhook handlers also ignore any event whose `session_id != kyc_provider_ref`, and re-KYC mints a fresh session). DB-only, no provider call. Triggers: ① **bank change** in `setBankAccount` (only when an EXISTING account changes, not first-time setup); ② **large disbursement** in `requestDisbursement` (`netAmount >= REKYC_LARGE_DISBURSEMENT_IDR`=5,000,000 AND last review older than `REKYC_STALE_DAYS`=180 → aborts the tx via `ReKycRequiredError`, then resets); ③ **dormant reactivation** in `MemberService.findById` (reuses existing `members.last_active_at`, gap > `REKYC_DORMANT_DAYS`=365; no new column, no cron); ④ **suspicious** = admin calls `resetKyc(reason='SUSPICIOUS')`. New `kyc_event` table is an append-only AML trail (RESET/SUBMIT/PENDING/APPROVE/REJECT, lifecycle events guarded by a real transition so webhook replays stay idempotent). Thresholds in `env.rekyc.*`. Spec: `docs/kyc-rekyc.md`.

- **Register = inactive-until-verified (NEW rule, not legacy):** both register paths create members `isActive=false`; the verify-OTP step (`validateOtpPhone` / `validateOtpEmail`) activates. A row with `legacyId=null && isActive=false && isEmailVerified=false && isPhoneVerified=false && scheduledDeletionAt=null` is a **reusable placeholder** (`legacyId!=null` = migrated legacy account, never reusable): re-registering the same email/phone overwrites it (predicate `isReusableUnverifiedMember` in `packages/common/src/utils/member-state.util.ts`). Password login on a placeholder → generic 401 (a `403 ACCOUNT_NOT_VERIFIED` discriminator exists in `loginWithPassword` but is commented out). `/auth/register` no longer returns tokens. Full spec: `docs/register-verification-flow.md`.

- **Tester account fixed-OTP bypass (NEW rule, for app-store review):** a whitelisted tester identifier (email/phone) satisfies any OTP with the fixed code **`000000`** — a real OTP can never be `000000` (`randomInt(100000,1000000)`). Centralised in `OtpService` (`packages/common/src/services/otp.service.ts`): `issue()` skips row creation + comms delivery (also dodges resend-guard/daily-cap); `verify()`/`consume()` accept the fixed code with no bcrypt/expiry check. Config read **live** via `testAccountConfig()` in `config/env.ts` (`TEST_ACCOUNT_ENABLED` default OFF, `TEST_ACCOUNT_OTP_CODE`, `TEST_ACCOUNT_IDENTIFIERS`). Must work in **prod** (App Review hits prod) — secured by the kill-switch + exact-match whitelist. Whitelist dummy accounts ONLY (a real identifier here = password reset via forgot-password). Seed the member with `pnpm seed:test-account`. Spec: `docs/test-account.md`.

- **Legacy resync = incremental transition-period sync (NEW, implemented):** during cutover legacy MariaDB is still written to, so already-migrated data is kept fresh by an incremental sync (NOT re-running `migrate:*`, which are insert-only `createMany`). Every legacy table has a Cresenity `updated` column → all syncers are **incremental** (`WHERE COALESCE(updated,created) > watermark`), catching inserts+edits+soft-deletes in one pass (residual gaps, logged: post/comment hard-deletes filtered by `status=1/is_active=1`, and un-likes = hard `DELETE` of a `like` row). 7 syncers in dependency order: **members → enrollments → kyc → tree → commissions → reviews → posts** (posts covers comments/replies/likes). Per-syncer watermark + stats in new `sync_state` table; dedup map moved from `scripts/member-redirect.json` to durable `member_redirect` table; run-lock is a TTL `__lock__` row in `sync_state` (not pg advisory lock). **members = new-wins-on-touch:** only `legacyId!=null` winners touched, only profile fields (`fullName/avatarUrl/bio/isActive`) overwritten, gated by `updatedAt <= legacySyncedAt` (a raw UPDATE sets both `updated_at` and `legacy_synced_at` to the same app-side `Date` param — NOT server `now()`, columns are tz-less `timestamp` filled with app-clock UTC everywhere else — so an app write trips the gate); legacy deactivation always propagates. **commissions** only ever touch `status=MIGRATED` (new Xendit rows have `legacyId=null`, no collision); `is_expired=1`→`VOIDED`. **kyc** guard `kycSource IN (NONE,LEGACY)`. Run from repo root: `pnpm resync [syncer...] [--dry-run] [--since=]` (one-shot CLI) or `pnpm resync:worker` (loop, interval = env `RESYNC_INTERVAL_SEC` default 3600, all syncers each tick); also `resync:seed-redirect` (import `scripts/member-redirect.json` → `member_redirect` table, once) and `resync:unlock` (clear a stale run-lock). **Code lives in `apps/resync-worker/`** (throwaway transition tool, retired after cutover — delete the app dir + the four `resync*` root scripts). Uses root `@prisma/client` + `@bb/common/utils/phone.util` directly (NO schema/util copy → no drift; this is why it was folded back in from the old standalone `bb-legacy-resync` repo, now archived). Resilient legacy connection: reconnects + retries on `ECONNRESET` up to `RESYNC_LEGACY_RECONNECT_RETRIES` (default 3). **Perf + run-to-run safety (2026-07-09):** all write loops are concurrent (`runConcurrent`, env `RESYNC_WRITE_CONCURRENCY` default 10; `ensureMember` in-flight memo prevents double-creates, pair-keyed tables claim their pair map synchronously); stored watermarks get an overlap re-scan (`RESYNC_WATERMARK_LAG_SEC` default 60 — legacy `updated` is set at PHP save() but visible at COMMIT); run-lock is heartbeat-refreshed per syncer (long run > TTL can't be taken over mid-write); end-of-run **backfill pass** re-scans kyc/tree/commissions/likes since epoch for members materialised on demand that run (their old legacy rows are behind the other watermarks forever otherwise). **Timezone:** legacy DATETIMEs are WIB wall-clock — the mysql2 conn (`timezone:'+07:00'`) converts both directions, so Postgres stores UTC (= legacy −7h); rows written pre-fix (before 2026-07-08) need one `pnpm resync:fix-dates` (covers members/enrollments/commissions/reviews/likes; posts+comments self-heal via upsert-update) — STILL PENDING on bb_backend, run it once after the in-flight first run finishes. Spec (design + business rules): `docs/legacy-resync-plan.md`.

- **Subscription Phase 1 = annual all-access, seat-based (NEW feature, implemented 2026-07):** 4 tier (SOLO/DUO/FAMILY/PREMIUM = 1/2/4/6 seat, 999K–2.799K) sebagai `Product type='subscription'` 1:1 `subscription_plans` — **harga di `products.price`** (checkout/voucher/Xendit reuse jalur commerce; Phase 2/3 = tambah row plan, zero-code). **Entitled** ⇔ pegang seat di sub ACTIVE dengan `coalesce(grace_until, expires_at) > now` (grace = setting `subscription.graceDays`, 7). **Aturan sakral enrollment:** row retail (`via_subscription_id` NULL) valid by EXISTENCE — `expired_date` legacy DIABAIKAN; row lazy (marker terisi) valid hanya selama `expired_date > now` (dibuat on-access, di-bump saat renewal, di-nol-kan saat remove/leave/refund; beli retail → marker dibersihkan = upgrade lifetime). **Idempotensi aktivasi** = ledger `subscription_activations` unique partial `transaction_id`, insert TERAKHIR dalam tx (redelivery → P2002 by COLUMN name → rollback no-op). Renewal = `expiresAt + period` (anchor ke expiry lama — grace = napas bayar, bukan bonus waktu; amandemen BB-79), expiry RC menang; repurchase pasca-EXPIRED = sub BARU; plan change hanya via RC PRODUCT_CHANGE (web 400). Cancel = intent (`canceled_at`, akses lanjut); refund = satu-satunya pemutus seketika. **Komisi flat L1-only** dari plan (40% first sale / `renewal_affiliate_rate` runtime, placeholder 20% nunggu COO); renewal terdeteksi via flag RC OR ledger non-NULL lain (grant tak dihitung); `attributionKey` per-periode utk produk plan. Jobs: expire SEBELUM reminder; reminder insert-first + suppression per siklus expiry. Grant kampanye >2jt: eligibility = commerce_transactions PAID + **legacy MariaDB langsung** (`LEGACY_DB_*`; `payment_amount` sering NULL — pakai `amount − amount_voucher`), guard ledger `kind='grant'` sekali seumur kampanye. ⚠️ Prod: 3 template bb-comms & SKU store masih placeholder. Full spec + runbook launch + query reporting: `docs/subscription-port.md`.

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

- [x] auth — OAuth/JWT, register, forgot-password, devices
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
- [x] admin — was done (EJS internal sysadmin), but `apps/admin-ejs` REMOVED 2026-07 (recover from git history if needed)
- [x] commerce / purchase — Xendit-only (CC + VA + eWallet), 2-step checkout→payment, voucher bypass, webhook + cron expire, event-driven side effects (enrollment + affiliate commission + voucher redeem). See `docs/commerce-port.md`. Pending: manual Xendit sandbox QA
- [x] subscription — Phase 1 annual (BE-01…BE-22 semua selesai): schema+ledger, service aktivasi/renewal/grant, seats, entitlement+lazy enrollment, event bus+listeners, komisi flat, RC lifecycle, guard checkout, jobs reminder/expire, notif+email, modul HTTP `/subscription`, script grant+eligibility (2 sumber). 15 spec / 93 test. See `docs/subscription-port.md`. Pending eksternal: template bb-comms, SKU store+RC, rate renewal COO
- [ ] backoffice — `apps/backoffice-api` scaffold REMOVED 2026-07 (was never started). Plan docs kept: `docs/backoffice-port-plan.md` + `docs/backoffice-port/`
- [~] disbursement — bank payout flow COMPLETE in `@bb/domain` (request AUTO/MANUAL + `disburseViaXendit` + webhook `/api/webhook/xendit/disbursement` + job `executeApprovedDisbursements` sweeps backoffice-approved rows & re-checks KYC at execution). Approval UI = **backoffice-bb repo** (`/disbursements`, perms `disbursements.view/manage`; approve = stamp `approved_at` via SQL only — Xendit key & state machine stay here). Legacy is bank-ONLY (e-wallet payout never existed — `TBBank` has no wallet entries; OVO/GoPay refs are payment-IN); e-wallet payout = new product decision (Payouts v2), not parity. Pending: legacy bank backfill (`bank_account_bank` lowercase keys → Xendit codes; `mandiri-syariah`→BSI), Xendit env keys + dashboard callback URL, sandbox QA
- [ ] chat / broadcast — drop or defer
- [ ] certificate — drop or defer
- [ ] cron / queue — drop (use Postgres LISTEN or external scheduler later)
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
- Migrate from legacy DB: `pnpm migrate:legacy` (script at `scripts/migrate-from-legacy.ts`)
- Swagger UI: `http://localhost:<port>/api/docs`
- New repo jcodemunch ID: `devtribelio/new-brainboost-backend`
- Legacy repo jcodemunch ID: `tribelio-platform`
