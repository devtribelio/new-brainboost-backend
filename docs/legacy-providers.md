# Legacy Provider Integrations — Not Yet Wired in New Backend

External services that `tribelio-platform` (legacy) integrates with, that `bb-backend-new` either does not yet implement or implements partially. Use this as the canonical follow-up list when a feature parity gap touches an external API.

Discovered as we audit; not exhaustive. Add entries as new gaps surface.

Status legend: 🔴 not started · ⚠️ partial (legacy-shape consumed but no outbound calls) · ✅ wired

---

## Messaging / OTP

### Qontak (WhatsApp Business API)  🔴

- **Used for**: phone-OTP dispatch on register / login-by-phone flows.
- **Legacy location**: `cresenity-app/application/tribelio/default/libraries/TBQontak/Engine/MemberVerificationOtpPhoneNumber.php` + `TBQontak::send(...)` core dispatch.
- **Legacy specifics**:
  - Channel: WhatsApp only — no SMS fallback. `channel` query param hardcoded to `qontak` in `channelAvailable`.
  - OTP code: 6 digits via `TBGenerateCode::generateOtpCode(6)`.
  - TTL: 2 minutes (`CCarbon::now()->addMinutes(2)`).
  - Resend cooldown: existing unverified OTP blocks resend until expiry.
  - Daily limit: 5 OTP requests/day per member (resets midnight UTC).
  - Hardcoded IDs in PHP (move to env vars when porting):
    - `channelIntegrationId: 9fe63a0f-e6c7-4a2e-b1ad-d12e69b5706c`
    - `templateId: 453e330c-64d6-434c-ba3e-900afd0da366`
  - Phone format: `TBUtils::sanitizePhone($phone, $phoneCode)` → full number with country code.
- **Current new-backend state**: T1.1-T1.3 phone-register shipped (commit pending). `verify-phone` OTP stored in `otp_codes` table; code logged via pino instead of dispatched. FE can read DB or logs for dev/QA.
- **Follow-up tasks**:
  - **T1.4** Qontak service `src/common/services/qontak.service.ts`. Env: `QONTAK_BASE_URL`, `QONTAK_ACCESS_TOKEN`, `QONTAK_CHANNEL_INTEGRATION_ID`, `QONTAK_TEMPLATE_ID`. Hook into `otpService.issue` for phone targets.
  - **T1.5** Tighten TTL (10 → 2 min), add resend cooldown + 5/day rate limit for parity.

### SMTP / Email transport  ⚠️

- **Used for**: password reset, account deletion, pre-registration OTP.
- **Legacy location**: `Controller_Login`, `TBMember`, framework `c::mailer` calls.
- **Current new-backend state**: `src/common/services/mailer.service.ts` already implemented (sends via SMTP env config). Not blocking.

---

## Media Storage 

### BunnyCDN (Stream + Storage)  🔴

- **Used for**: course audio + video hosting/playback.
- **Legacy location**: video assets uploaded to Bunny Stream library; mobile reads `videoLibraryId` + `guid` for HLS playback URLs. Audio uses Bunny Storage `vz-5439ef3e-878` bucket.
- **Legacy specifics** (from `docs/api-fe.md` §2.8):
  - Bunny Stream API: `GET https://video.bunnycdn.com/library/{libraryId}/videos/{videoId}` — header `AccessKey: {bunnynetStreamApiKey}`.
  - Bunny Storage audio: `GET https://storage.bunnycdn.com/vz-5439ef3e-878/{audioId}/original?accessKey={token}&download` → raw bytes.
- **Current new-backend state**: `serializeCourseDetailLegacy` (P5 dataContent flatten) emits `videoLibraryId` + `guid` pass-through from JSONB — backend never calls Bunny. Mobile calls Bunny directly. Acceptable.
- **Follow-up tasks**:
  - **TX.1** Server-side upload to Bunny when admin uploads lesson assets. Currently admin module accepts raw uploads to local disk (`uploads/`); should push to Bunny on success.
  - **TX.2** Signed URL generator for restricted Stream library access (per-member tokens), if Bunny library is configured private.

### AWS S3 / `TBAWS`  🔴

- **Used for**: legacy asset bucket (profile pics, post images, banner images).
- **Legacy location**: `libraries/TBAWS.php` — wraps S3 SDK.
- **Current new-backend state**: local disk `uploads/` via multer. Not production-ready.
- **Follow-up tasks**:
  - **TX.3** S3 adapter behind upload service. Env: `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET`. Swap multer `diskStorage` for `multerS3`. Migrate URL emit to S3 / CloudFront prefix.

---

## Payment / Disbursement

### Apple App Store / Google Play (IAP receipt verification)  🔴

- **Used for**: in-app purchase verification for premium plans.
- **Legacy location**: `TBPlan::planIdFromAppleProduct`, equivalent Google Play paths under `Controller_Commerce`.
- **Current new-backend state**: commerce module not started (per `docs/rewrite-progress.md`).
- **Follow-up tasks**:
  - Apple: validate receipt against `https://buy.itunes.apple.com/verifyReceipt` (production) + `sandbox` fallback.
  - Google: server-side verification via Play Developer API.

### Indonesian payout rails — bank + e-wallet  🔴

- **Used for**: affiliate commission disbursement.
- **Legacy location**: `Controller_Disbursement` + `TBDisbursement`. Routes to:
  - Banks: BCA, BRI, Mandiri (likely via Xendit / Midtrans aggregator)
  - E-wallets: OVO, GoPay
- **Current new-backend state**: disbursement module not started.
- **Follow-up tasks**: pick aggregator (Xendit / Midtrans / Flip), integrate.

---

## Infrastructure

### Task queue (`TBTaskQueue_*`)  🔴

- **Used for**: notification fan-out, email/WA dispatch, IAP verification retry.
- **Legacy location**: `libraries/TBTaskQueue/*`. DB-backed queue (MySQL).
- **Current new-backend state**: notification dispatch is synchronous (no queue). Works for current volume; will bottleneck under fan-out.
- **Follow-up tasks**: Postgres `LISTEN/NOTIFY` for in-process queue OR external (BullMQ + Redis, pg-boss).

### Search  🔴

- **Used for**: post / topic / member fulltext search.
- **Legacy location**: MySQL `MATCH ... AGAINST` fulltext indices.
- **Current new-backend state**: naive `contains` queries (case-insensitive ILIKE). Adequate for low cardinality; doesn't scale.
- **Follow-up tasks**: Postgres `pg_trgm` extension + GIN index OR external (Meilisearch / Typesense).

---

## Push Notifications

### FCM (Firebase Cloud Messaging)  ⚠️

- **Used for**: mobile push notifications.
- **Legacy location**: stored on `Member.cloud_messaging_id`, dispatched via Firebase Admin SDK.
- **Current new-backend state**:
  - Device + FCM token enrollment endpoints wired (T2.2, T2.12, P2 — `Device.fcmToken` + `Member` registration).
  - **Outbound FCM `send()` calls are not implemented.** Notifications are persisted to `notifications` table but never pushed to devices.
- **Follow-up tasks**:
  - **TX.4** Firebase Admin SDK integration. Env: `FIREBASE_SERVICE_ACCOUNT_JSON`. On notification create, batch-send to all live FCM tokens for the member.

---

## How to extend this doc

When a new provider gap surfaces (during audit, tracker work, or PR review), add an entry here under the closest category. Keep entries short:
1. Provider name + status emoji.
2. What it's used for.
3. Legacy code anchor (file or class).
4. Specific bits (IDs, endpoints, TTLs) worth carrying over.
5. Current new-backend state.
6. Follow-up task ID(s) — link to `fe-api-progression.md` if applicable.

Don't paste full source — link via legacy file path; jcodemunch can fetch on demand.
