# Rewrite progress

Per-module status for the `tribelio-platform` → `bb-backend-new` rewrite. Update opportunistically.

Legend: `[ ]` not started · `[~]` in progress · `[x]` parity met for current scope · `[!]` blocked

> **2026-05-29 — monorepo extraction (ADR-0001) landed** on `chore/monorepo-split`.
> Module paths below moved: `src/modules/<f>/` → `apps/mobile-api/src/modules/<f>/`;
> service/rule layer → `packages/domain/`; `src/common`+`config` → `packages/common/`;
> prisma client → `packages/db/`; admin → `apps/admin-ejs/`; new `apps/backoffice-api/`
> scaffold. 40 test files / 238 tests green on new layout.

---

## Done ([x])

### auth — `src/modules/auth/`
- OAuth-shaped JWT endpoints under `/api/member/oauth/*` and `/api/member/auth/*`.
- Grants: `password`, `refresh_token`, `social` (Google/Facebook/Apple).
- Forgot-password OTP flow: `requestForgotPassword` → `validateOtp` → `forgotPasswordVerification`.
- Device + FCM token register.
- Outstanding: parity tests against legacy social-login provider tokens.

### account — `src/modules/account/`
- Profile info/update, change-password, logout, pre-registration, delete-account, payment token, affiliate-connect.
- Mirrors legacy `Controller_Account` API surface.

### member — `src/modules/member/`
- `GET /member/info`, list, member info DTO matches legacy shape.

### profile — `src/modules/profile/`
- View, update, set location.

### location — `src/modules/location/`
- Country / province / city / district lookup with pagination + keyword search.
- Source data seeded via Prisma seed (Indonesian admin divisions).

### upload — `src/modules/upload/`
- Multer-backed multipart upload to local `uploads/`.
- TODO: swap to S3 (`TBAWS` parity) before production.

### banner — `src/modules/banner/`
- List banners; minimal — matches `TBBanner`.

### product — `src/modules/product/`
- Course detail endpoint at full 1:1 parity with legacy `Controller_Product::detail` (commits `b1370fe`, `d2bd550`).
- DTOs match the exact shape mobile expects (8 DTOs).
- Course-detail serializer scrubs Bunny `guid`/`videoLibraryId`/iframe-HTML from `slidesData` + `dataContent`; audio/video slides expose `streamUrl` (opaque media token) — see `media` module + `docs/media-port.md`.
- Outstanding: catalog filters, purchase flow (lives in unstarted `commerce` module).

### media — `src/modules/media/`
- Backend proxy for BunnyCDN Stream — streams MP4 renditions so the raw `guid`/`library_id` never reach the client.
- Endpoint `GET|HEAD /api/member/media/stream?t={token}&res={360p|480p|720p}`; opaque AES-256-GCM token carries `guid`/`courseId`/`isPreview`.
- Preview media open (anonymous OK); non-preview gated on `CourseEnrollment`. HTTP Range forwarded for seek/resume.
- Model C (signed-URL) code shipped behind `MEDIA_MODE` (default `proxy`); `signed` mode 302-redirects to a Token-Auth signed Bunny HLS URL. Flip needs the new-library content migration — see `docs/media-model-c-migration.md` §11.
- Tests: `media-token` (5), `bunny-sign` (7), `media` (10), `media-signed` (5) — all green.
- Plan + Bunny audit: `docs/media-port.md`, `docs/media-model-c-migration.md`.

### commission — `src/modules/commission/`
- Read-only list, performance schema metadata.
- Write path (creating commissions) lives in `affiliate`.

### topic — `src/modules/topic/`
- CRUD.

### post — `src/modules/post/`
- Feed + CRUD (18 service methods).
- Includes pin/unpin, like, save, view-count.

### comment — `src/modules/comment/`
- Create / list / delete / like.

### reply — `src/modules/reply/`
- Minimal (1 service method); attached to comments.

### network — `src/modules/network/`
- CRUD, join/leave, member list.
- `/network/member` with empty `input` lists all members (legacy parity — commit `95a40c2`).
- Seeds for community networks: commit `ffabd9d`.

### notification — `src/modules/notification/`
- List, mark-read, unread-count.
- Synchronous fan-out for now — queue when volume grows.

### report — `src/modules/report/`
- Submit user/post/comment report. 7 service methods.

### admin — `src/modules/admin/`
- Cookie-JWT auth, dashboard, EJS views.
- `crud-factory` generates basic CRUD for indexed resources (`resources/index.ts`, 27 entries).
- `resources/loaders.ts` provides 12 Prisma loaders.

### response envelope consolidation (2026-05-19)
- Collapsed `ok()` + `okLegacy()` + `buildLegacyPage()` into a single envelope `{ success, data, meta, error }`.
- New helpers: `ok`, `okCreated`, `okPaginated`, `fail` in `src/common/utils/response.util.ts`.
- Login `/oauth/token` now wrapped; webhook stays raw (provider contract).
- Status 201 applied to all POST-creates (checkout, payment, affiliate enroll, post/comment/report/register).
- Error vocabulary: `BAD_REQUEST`, `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `INTERNAL_ERROR`.
- Big-bang mobile rollout — see `docs/api-envelope.md` for spec + client migration notes.

---

## In progress ([~])

### affiliate — `src/modules/affiliate/`
- Constants (`PBS_TIER_*`, `GROWTH_LEVEL_RATES`, `COOKIE_DAYS`, etc.) ✅
- `code-generator.ts`, `compute-amount.ts`, `walk-inviter-chain.ts` ✅
- `affiliator.service.ts`, `enrollment.service.ts`, `program.service.ts`, `visit.service.ts` — wired ✅
- Recursive CTE for inviter chain (`walkInviterChain`) ✅
- **Outstanding:**
  - Parity tests against legacy fixture rows (commission compute, multitier walk).
  - PENDING → BALANCE state machine (cron job + the 7-day delay).
  - Reconciliation report (audit trail vs. legacy).
- See `plan.md` for full design.

---

### commerce / purchase — [x] P1-P6 implemented (manual Xendit sandbox QA pending)
- Legacy: `Controller_Commerce` + `Controller_Payment::commerce` + `Controller_Product::checkoutSubmit` + `TBCommerce` + `TBXendit` + `TBVoucher`.
- Scope: Xendit-only (CC + VA + eWallet), 2-step (checkout → payment), voucher with bypass-charge path, affiliate commission via existing `walkInviterChain`.
- **IAP dropped** (Apple/Google receipts not in scope — defer to subscription module).
- **Cart / shipping dropped** (mobile single-product only).
- Routes (`/api/member/product/checkout/submit`, `/api/member/payment/commerce*`, `/api/webhook/xendit/{va,ewallet,cc}`) wired + smoke-tested.
- Side effects (course enrollment, affiliate commission, voucher redeem) idempotent via unique constraints; emitted from PaymentService SUCCESS path + webhook.
- Cron `expirePendingPayments` (call from external scheduler) flips overdue PENDING → EXPIRED.
- Tests: 47 commerce + 6 smoke = 53 specs, 125 total project green.
- Plan + tracker: see `docs/commerce-port.md`.
- **Open items**: Xendit sandbox manual QA (CC + VA simulate-payment + eWallet OVO/DANA); fee table confirm with finance; refund flow (admin tool, defer).

## Not started ([ ])

### disbursement
- Legacy: `Controller_Disbursement` + `TBDisbursement` + `TBBank` + provider integrations.
- Scope: list balance, request payout, bank/e-wallet routing (Indonesian rails).
- Blocking: needs commerce → commission → balance pipeline complete.

### comms / outbound messaging (producer side) — [~] F1 + F3 done; F4 first slice done
- Legacy: `TBEmail` (SES, 4 SQS tiers) + `TBQontak` (WhatsApp OTP).
- Decision: outbound delivery (email + WhatsApp + future SMS) lives in a **separate repo `bb-comms`** (ADR-0002), not this monorepo. This repo is producer-only.
- **F1 done (producer foundation):** `NotificationOutbox` + `comms_delivery` + `comms_idempotency` tables (migration `20260608133956_comms_outbox`); `@bb/common/mq` (comms-contract + topology + amqplib publisher); `enqueueComms()` helper (tx-aware); `comms-relay` daemon (`pnpm relay:comms`, log-only when `RABBITMQ_URL` unset); env rabbitmq block. Tests 300/300 green.
- **F3 done (phone OTP cutover):** `otp.service.issue()` writes otp row + comms outbox row in one txn for phone targets → relay → RabbitMQ → bb-comms → Qontak. Live e2e proven end-to-end (outbox→relay→queue→consume→delivery log). bb-comms scaffold runs as consumer. Email OTP still inline (moves F4).
- **F4 first slice done (CoursePaymentSuccess email):** bb-comms has SES sender (dev-noop w/o creds) + MJML/Handlebars renderer + a buyer-receipt handler that reads `commerce_transactions ⋈ members ⋈ products` by refId (Kysely, generated types). bb-platform listener enqueues on `commerce.payment.success`. Live e2e proven (outbox→relay→queue→PG join→MJML→SES dev-noop→delivery log). **Scope note:** transactional templates are NOT 1:1 legacy ports — legacy `CoursePaymentSuccess` was the multitenant SELLER notice; the new one is a clean buyer receipt from the new schema. Most legacy seller/chief/network templates are out of mobile scope.
- **F4 templates DONE (every type with a real producer hook), all e2e proven:**
  - `otp` (phone WhatsApp + email) — all OTP now via outbox; inline SMTP/Qontak dropped from otp.service.
  - `CoursePaymentSuccess` (buyer receipt) ← commerce.payment.success
  - `AffiliatorCommisionCourse` (earner) ← affiliate.commission.created (new affiliateEvents)
  - `CommerceRefunded` (buyer) ← commerce.payment.refunded
  - `CommercePaymentExpired` (buyer) ← commerce.payment.expired
  - bb-comms has a shared `makeCommerceTxnEmailHandler` factory for simple txn-keyed buyer emails.
- **NOT built — no trigger in the simplified backend (not a gap):** disbursement/withdraw emails (disbursement module NOT STARTED), reminder emails (no scheduler), social Post/Comment (in-app notification, email out of scope per product), network (single-tenant simplified), AffiliateJoin (enroll has no event; marginal), all seller/chief/multitenant legacy templates (out of scope). Revisit when those modules/schedulers land.
- **F5 cleanup DONE:** deleted `mailer.service.ts` + `whatsapp.service.ts`, dropped `smtp.*`/`qontak.*` env blocks + `nodemailer` dep. bb-platform is now a **pure comms producer** — it enqueues to the outbox, never sends. (`phone.util.ts` kept — own spec, pure util.)
- **F6 deploy artifacts DONE (bb-comms):** Dockerfile (multi-stage, validated — builds + runs in prod mode, connects RabbitMQ + consumes), pm2 `ecosystem.config.cjs`, GitHub Actions CI (typecheck+test+build, no DB/broker), `.dockerignore`, README deploy section. Pinned pnpm@10.33.2; moved pino-pretty to deps.
- **F6 remaining — needs operator action (not code):** (1) create remote `devtribelio/bb-comms` + push (repo is local-only, no auto-push); (2) prod `pnpm prisma:deploy` from bb-platform to migrate `notification_outbox` + `comms_*` to the prod DB; (3) provision prod RabbitMQ `comms` vhost + inject bb-comms env (DATABASE_URL, RABBITMQ_URL, QONTAK_*, AWS SES). Comms port (F1–F6) otherwise complete.
- OTP gen/store/verify/consume + in-app feed + FCM push **stay** here.
- bb-comms scaffold lives at `/home/cold/code/werk/bb/bb-comms` (separate git repo).
- ⚠️ Migration gotcha: `migrate dev` shadow replay is blocked by pre-existing broken migration `20260525075123` (`affiliate_visits_program_id_fkey` missing). New migrations must be authored via `migrate diff --from-url` + `migrate deploy` until that's fixed.

### chat / broadcast
- Legacy: `TBChat`, `TBBroadcast`, `TBAgora` (live).
- Likely deferred or split to its own service. Confirm with product.

### certificate
- Legacy: `TBCertificate` — PDF cert on course completion.
- Defer until course completion tracking is wired.

### cron / queue
- Legacy: `TBTaskQueue_*`, `controllers/cron.php`.
- Decision: avoid building in-app queue. Use Postgres LISTEN/NOTIFY or external scheduler when needed.

---

## Explicitly dropped

- `tribeliopage/` (landing page builder)
- `cresenity/` (framework demo)
- `shortlink/`
- `TBCanvas` (drag-drop page builder)
- `TBCms` (web CMS)
- `TBFacebook::adsAuth`, `TBGoogle::adsAuth` (Ads API)
- Creator/studio web views (`views/creator`, `views/studio`)
- Multi-tenancy (`org_id`, `network_account_id`)
- Super-affiliate / chief tier
- Per-program rate config (constants in code only)

---

## Cutover checklist (per module)

When marking a module `[x]`:

1. All legacy endpoints in scope have a corresponding `bindRoute` and a passing route smoke (`tests/api-smoke.spec.ts`).
2. Service-level unit tests cover the business rules from `CLAUDE.md` §5 that apply.
3. OpenAPI schema renders without warning (`tests/swagger-smoke.spec.ts`).
4. Any new env vars are declared in `src/config/env.ts` and listed in `.env.example`.
5. `index_file` run on every edited file.
6. Anything non-obvious added under `docs/legacy-analysis.md`.
