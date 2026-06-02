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
> (`.npmrc`). Dev: `pnpm dev:mobile` / `dev:backoffice` / `dev:admin` (tsx
> `--conditions=development` → resolves `@bb/*` to package source). Prod build: `tsup`
> per app (bundles `@/*` + `@bb/*`). Tests: `pnpm test` (vitest workspace, real Postgres).

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
  backoffice-api/ :3001    # JSON product-ops API (scaffold; see backoffice-port-plan.md)
  admin-ejs/      :3002    # EJS internal sysadmin (views/, public/) + modules/admin
prisma/                    # SINGLE source of truth — schema.prisma (UUID v7, legacyId Int?),
                           #   migrations/, seeds/  (root-level, shared by all apps)
tests/setup.ts             # shared vitest setup; specs live in apps/*/tests/
```

Each consumer maps `@bb/*` paths to built `dist` for `tsc` typecheck; node/tsx/vitest
resolve via package `exports`. Add a new mobile module under `apps/mobile-api/src/modules/`
and register it in that app's `core/register-modules.ts`.

### Legacy → New module map

> Path note (post ADR-0001): `src/modules/<feature>/` in the rows below now lives at
> **`apps/mobile-api/src/modules/<feature>/`**; `src/modules/admin/` → **`apps/admin-ejs/`**;
> `src/modules/backoffice/` → **`apps/backoffice-api/`**. Service/rule layer of
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
- **Attribution model:** last-touch overwrite, 30-day cookie window (`COOKIE_DAYS = 30`).
- **PENDING → BALANCE:** commissions move 7 days after payment (`PENDING_TO_BALANCE_DAYS = 7` — marketing-facing "5 hari kerja").
- **Affiliate code length:** member code = 6 chars, program code = 8 chars, alphabet `[A-Z0-9]`.
- **Member.legacyId:** Int, unique, **must be populated** when migrating users from legacy. Mobile app uses it as the primary identifier in some endpoints.
- **OAuth grant types** the mobile app sends: `password`, `social`, `client_credentials`, `refresh_token` (legacy `AuthService`). Refresh path is `POST /api/member/oauth/token` with `grant_type=refresh_token` — **not** `/oauth/refresh`. The `refreshTokenUrl` constant in the mobile client points at the unused path; don't be confused.
- **Network member list** edge: `/network/member` with empty `input` lists **all** members (mirrors legacy tag filter behavior — see commit `95a40c2`).
- **Media access (BunnyCDN):** course audio + video both live in one Bunny **Stream** library (id `157244`, CDN `vz-5439ef3e-878.b-cdn.net`) — there is no separate Storage zone. Bunny's only protection is referrer-gating (any `Referer` header → `200`), which is hotlink protection, **not** access control. The `media` module proxies MP4 renditions and the product serializer emits an opaque `streamUrl` token so `guid`/`videoLibraryId` never reach the client. Preview lessons (`isPreview`) stream without enrollment; non-preview requires `CourseEnrollment`. See `docs/media-port.md`.

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
- [x] admin — auth, dashboard, CRUD scaffolding via `crud-factory` (EJS internal sysadmin)
- [x] commerce / purchase — Xendit-only (CC + VA + eWallet), 2-step checkout→payment, voucher bypass, webhook + cron expire, event-driven side effects (enrollment + affiliate commission + voucher redeem). See `docs/commerce-port.md`. Pending: manual Xendit sandbox QA
- [ ] backoffice — JSON-only product-ops API under `/api/backoffice/*` (port of legacy Tribelio admin + Oracle methods). 6-sprint plan in `docs/backoffice-port-plan.md`. Distinct from `admin` (which is EJS-only). NOT STARTED
- [ ] disbursement — payout to bank/e-wallet (NOT STARTED — folded into backoffice sprint 2)
- [ ] chat / broadcast — drop or defer
- [ ] certificate — drop or defer
- [ ] cron / queue — drop (use Postgres LISTEN or external scheduler later)

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
