# Rewrite progress

Per-module status for the `tribelio-platform` → `bb-backend-new` rewrite. Update opportunistically.

Legend: `[ ]` not started · `[~]` in progress · `[x]` parity met for current scope · `[!]` blocked

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
- Outstanding: catalog filters, purchase flow (lives in unstarted `commerce` module).

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

## Not started ([ ])

### commerce / purchase — Planning ([~] in design, [ ] not implemented)
- Legacy: `Controller_Commerce` + `Controller_Payment::commerce` + `Controller_Product::checkoutSubmit` + `TBCommerce` + `TBXendit` + `TBVoucher` (TBD).
- Scope (locked): Xendit-only (CC + VA + eWallet), 2-step (checkout → payment), voucher with bypass-charge path, affiliate commission via existing `walkInviterChain`.
- **IAP dropped** (Apple/Google receipts not in scope — defer ke subscription module).
- **Cart / shipping dropped** (mobile single-product only).
- Plan: see `docs/commerce-port.md` (full schema, API, sequences, phasing P1-P6).
- Blocking before P1: locate Xendit fee table per channel; confirm bank codes; design order code sequence.
- Blocking before P5 (commission listener): affiliate parity tests should land first so commission writes are trusted.

### disbursement
- Legacy: `Controller_Disbursement` + `TBDisbursement` + `TBBank` + provider integrations.
- Scope: list balance, request payout, bank/e-wallet routing (Indonesian rails).
- Blocking: needs commerce → commission → balance pipeline complete.

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
