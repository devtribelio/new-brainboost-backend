# Legacy analysis — tribelio-platform → bb-backend-new

Deep notes from analyzing the legacy `tribelio-platform` monolith. Lives outside `CLAUDE.md` so the per-session prompt stays small. Update opportunistically; not every fact below must be re-verified each session.

Repo IDs:
- Legacy: `tribelio-platform` (PHP/Cresenity, 50,035 symbols, 1,809 PHP files)
- New: `devtribelio/new-brainboost-backend` (TypeScript/Express/Prisma)

Legacy git HEAD at index time: `f21b6f167e494874b182bf1765a3dcd4dbeb2fb8` ("init: convert to monorepo & remove submodules", 2026-05-05). Most files have a single-commit history because the previous git history was lost in the monorepo conversion. This means `get_symbol_provenance` will frequently report `lineage_count=1` — that's the import event, not the symbol's real lifespan.

---

## 1. Macro layout

`cresenity-app/` is the Cresenity (CodeIgniter-derived) PHP framework root. It hosts 5 apps under `application/`:

| App | Status | Purpose |
|---|---|---|
| `tribelio/` | **PRIMARY** | Mobile API + creator/studio web. Source of truth for the rewrite. |
| `tribelio-admin/` | secondary | Separate admin panel app. New repo subsumes this under `src/modules/admin/`. |
| `tribeliopage/` | drop | Public landing page builder. Out of scope. |
| `cresenity/` | drop | Framework demo / starter. |
| `shortlink/` | drop | URL shortener side-project. |

`cresenity-app/system/` and `cresenity-app/modules/cresenity/` are framework code — **never port**. When `search_symbols` returns hits in `system/**`, filter them out with `file_pattern: "cresenity-app/application/tribelio/**"`.

### Mobile API entry point

All mobile traffic enters via `application/tribelio/default/controllers/api.php`:

```php
class Controller_Api extends TBController {
    public function member($method, $submethod) { ... TBApi::instance(TBApi::GROUP_MEMBER)->exec($method); }
    public function creator($method) { ... TBApi::instance(TBApi::GROUP_CREATOR)->exec($method); }
    public function oracle($method) { ... TBApi::instance(TBApi::GROUP_ORACLE)->exec($method); }
}
```

`TBApi::exec($methodName)` reflects on classes named `{Group}_{methodName}` (e.g. `Member_GetProfile`, `Creator_CreateCourse`) in `libraries/`. **There is no router map** — adding an endpoint = adding a class. The new repo's `bindRoute` + `register-modules` is the deliberate inverse.

URL shape: `/{base}/api/{group}/{method}[/{submethod}]` →
- `/api/member/getProfile`
- `/api/member/course/getDetail` (groupMap collapses `course.getDetail` → `Course_getDetail`)
- `/api/creator/getCourse`

Group → class prefix map (from `Controller_Api::resolveMethod`):

| Method segment | Class prefix |
|---|---|
| `commerce` | `Commerce_` |
| `commerceAdmin` | `Commerce_Admin_` |
| `businessCampaign` | `BusinessCampaign_` |
| `space` | `Space_` |
| `canvas` | `Canvas_` |
| `course` | `Course_` |
| `revenue` | `Revenue_` |
| `shipper` | `Shipper_` |
| `spinwheel` | `Spinwheel_` |
| `workflow` | `Workflow_` |

Subgroups marked **drop** for the rewrite: `space`, `canvas`, `businessCampaign`, `revenue`, `shipper`, `spinwheel`, `workflow`. `commerceAdmin` is admin-app concerns — fold what we need into `src/modules/admin/` instead of a separate prefix.

---

## 2. Key legacy libraries (tribelio/default/libraries/)

The `TB*.php` libraries are the legacy "service layer". Each is a class with mostly static methods. Mapping table:

| Legacy lib | Lines | Concerns | New home |
|---|---|---|---|
| `TB.php` | core helper (network, org, request) | currently mostly **dead** in monolith snapshot — most methods have no callers (see §6) | drop most; only `TB::isDevelopment` style helpers needed → `config/env.ts` |
| `TBApi.php` | API dispatcher | `exec`, `instance`, `GROUP_*` | replaced by `bindRoute` + `register-modules` |
| `TBAffiliate.php` | affiliate join/disjoin | `getAffiliateId`, `getCommisionPercentAffiliate`, `getMemberForAffiliateCode`, `getAffiliateDisbursementCommision` | `src/modules/affiliate/affiliator.service.ts` |
| `TBAffiliator.php` | tier + percent logic | `getPerformanceSchemaPercent`, `getPriceRecipient`, `isAffiliateExpired`, `PERFORMANCE_SCHEMA_*`, `INACTIVE_COMMISION_PERCENT` | `src/modules/affiliate/utils/compute-amount.ts`, `constants.ts` |
| `TBCommerce.php` | catalog + share URLs | `getProductUrl`, `getProductShareLink`, `commerceAuthId` | `src/modules/product/product.service.ts` |
| `TBCourse.php` | course CRUD + analytics | `buildScriptTrack`, `buildScriptGoogleTagManager`, `getInformationReview`, `saveReview`, `courseContentSummary`, `duplicate`, `republish` | course parts → `src/modules/product/`; tracking pixels → drop (mobile uses Firebase) |
| `TBProduct.php` | product helpers | `getProductUrl` | `src/modules/product/` |
| `TBPlan.php` | IAP plan mapping | `planIdFromAppleProduct` | needed by future `commerce/purchase` module |
| `TBCommision.php` | commission ledger | (note typo) | `src/modules/commission/commission.service.ts` |
| `TBBalance.php` | wallet balance | | future `commerce/balance` module |
| `TBDisbursement.php` | payouts | `affiliate(...)` | future `disbursement` module |
| `TBBank.php` | bank account | | future `disbursement` module |
| `TBMember.php` | member CRUD | | `src/modules/member/`, `account/`, `profile/` (split by concern) |
| `TBChat.php`, `TBBroadcast.php` | realtime chat | | **drop** for now (mobile chat is a separate workstream) |
| `TBCertificate.php` | course completion certificate | | defer |
| `TBCanvas.php` | drag-drop page builder | | **drop** (web-only) |
| `TBCms.php` | content blocks | | **drop** |
| `TBAWS.php`, `TBAsset.php` | S3 upload helpers | | `src/modules/upload/` (S3 not yet wired — local disk) |
| `TBFacebook.php`, `TBGoogle.php` (`adsAuth`) | OAuth social login + Ads API | `social` grant only | `src/modules/auth/` (social grant); Ads API → drop |

### TBController

`TBController` extends `CController` (framework). Common methods you'll see in legacy:
- `$this->setSession(...)`, `$this->getCurrentMember()` — session-based; replaced by JWT `req.user`.
- `c::response()->json(...)` — replaced by `ok(res, ...)` helper.
- `carr::get($arr, 'key', $default)` — replace with typed DTO access.

---

## 3. URL shape parity (mobile contract)

Mobile client paths are listed in `API_ENDPOINTS.md`. **Do not rename these** — the mobile app ships compiled URLs. Confirmed must-keeps:

- `POST /api/member/oauth/token` — login + refresh (single endpoint, `grant_type` discriminates)
- `POST /api/member/auth/register`
- `POST /api/member/auth/devices`
- `POST /api/member/auth/cloudMessaging` (FCM token register)
- `POST /api/member/auth/requestForgotPassword`
- `POST /api/member/auth/forgotPasswordVerification`
- `POST /api/member/auth/validateOtp`
- `POST /api/member/account/preRegistration`
- `POST /api/member/account/logout`
- `POST /api/member/account/changePassword`
- `GET  /api/member/account/profile/info`
- `POST /api/member/account/profile/update`
- `POST /api/member/account/profile/location`
- `GET  /api/member/info`
- `GET  /api/member/data/location/{country|province|city|district}`
- `GET  /api/member/banner`
- `GET  /api/member/product` + `GET /api/member/product/detail`
- `GET  /api/member/commission`
- `GET  /api/member/notification`
- `GET  /api/member/topic`
- `GET|POST /api/member/post`
- `GET|POST /api/member/comment`
- `GET|POST /api/member/reply`
- `GET|POST /api/member/network*`
- `POST /api/member/upload`
- `POST /api/member/report`

The mobile app uses **camelCase URL segments** (`/changePassword`, `/cloudMessaging`). Match exactly — `/change-password` will 404 the client.

---

## 4. Database mapping caveats

### `legacyId Int? @unique`

Every entity that mobile may reference by integer ID gets this. The naming "legacy" is a **misnomer** — see auto-memory `[[project_rewrite_context]]`. The column is the active mobile-compat ID. Do **not** delete it once a module is "fully migrated"; rename only if every mobile build in the field is updated to UUID.

### Affiliate-related models

- `Member.inviterId` (UUID) — parent in inviter chain. The legacy column was `member_invitator_id` on `member` table.
- `Member.affiliateBased` — `'PERFORMANCE' | 'GROWTH' | 'INACTIVE'`. Default `'PERFORMANCE'` for new members; existing legacy users migrate as-is (~670K PERFORMANCE, ~16K GROWTH per `plan.md`).
- `Member.affiliateCode` — 6-char `[A-Z0-9]` code. Generate via `affiliate/utils/code-generator.ts`.
- `Visit` table — every affiliate-link click logged with UTM + raw query/header. Last-touch overwrites attribution within 30-day window.
- `Commission` — has `schemaType` snapshot (`SCHEMA_1|2|3`) so historical commissions never re-compute when a tier threshold changes.

### `Member.phone` uniqueness

Phone is `@unique` but mobile clients can register without phone (phone-verified flow is separate). Keep nullable.

### `Network` (community)

Joined via tag matching (`/network/member` empty-input edge case — see commit `95a40c2`). Don't add a "must specify tag" guard.

---

## 5. Auth notes

Legacy flow:
1. Mobile → `POST /api/member/oauth/token` with `grant_type=password` and `username`/`password`.
2. Server returns `access_token` + `refresh_token` (OAuth2 via `CApi_OAuth`).
3. Subsequent calls send `Authorization: Bearer <access_token>`.
4. Refresh via the **same** endpoint with `grant_type=refresh_token`.
5. Social login: `grant_type=social` with `provider=google|facebook|apple` + provider token.

New flow keeps the URL shape and grant types but issues plain JWT (no OAuth2 ceremony). `src/modules/auth/auth.service.ts` is the single place that owns this.

OTP / forgot-password:
- `requestForgotPassword` → sends OTP via email/SMS.
- `validateOtp` → returns a short-lived "reset token".
- `forgotPasswordVerification` → consumes reset token + new password.

Devices:
- `auth/devices` registers an Android/iOS device with a deviceId.
- `auth/cloudMessaging` registers an FCM token bound to the device.

---

## 6. Dead code in legacy (sample)

Run with: `get_dead_code_v2 {repo: "tribelio-platform", file_pattern: "cresenity-app/application/tribelio/default/libraries/**", min_confidence: 0.67}`.

Confirmed dead at confidence 1.0 (no callers, no barrel export, file unreachable):

- Most of `libraries/TB.php` static helpers: `setCurrentNetworkFromSubdomain`, `setCurrentNetworkAccountFromCode`, `setCurrentNetworkAccountFromId`, `appName`, `org`, `currentNetworkDomain`, `currentNetworkSubdomain`, `network`, `networkId`, `networkAccount`, `isApi`, `orgDomain`, `orgHomePage`, `orgHomeMemberPage`, `tribeHomePage`.

Caveat: jcodemunch's dead-code detection has a framework-warning for this index — Cresenity controllers are reached by **convention** (URL → class name), not by static imports. So *file-level* dead code on libraries is reliable; *file-level* dead code on `controllers/**` is **not** — assume controllers are live unless proven otherwise.

If you need to confirm a library file is truly unused: also `search_text` for the class name in `application/tribelio/**` and `tribelio-admin/**`.

---

## 7. Critical symbols (top by importance / PageRank)

In the new repo, the most-imported symbols (PageRank-ranked) are:
1. `PropertyOptions` (openapi/types) — DTO decorator config type
2. `ApiBearerAuth` (openapi/decorators) — auth decorator
3. `required` (config/env) — env var assertion
4. `HttpException` (exceptions)
5. `prisma` (config/prisma) — singleton client
6. `AppModule` (core/module.interface)
7. `buildApp` (app.ts)
8. `bindRoute` (openapi/route-binder)
9. `signAccessToken` (utils/jwt)
10. `parsePagination` (utils/pagination)

Changes to any of these have wide blast radius — run `find_importers` before refactoring.

Legacy PageRank is dominated by demo/starter controllers (e.g. `Controller_Demo`, `Controller_Home` in cresenity/) because of how the framework graph indexes. **Not useful for the rewrite** — search by domain instead.

---

## 8. Open questions / parity TODOs

- **Commerce / purchase flow:** not started in new repo. Legacy is `Controller_Commerce` + `TBCommerce` + IAP receipt verification (`TBPlan::planIdFromAppleProduct`, equivalent Google Play). Needs design.
- **Disbursement:** legacy `Controller_Disbursement` + `TBDisbursement`. Affiliate payout to bank/e-wallet (Indonesian rails: BCA, BRI, Mandiri, OVO, GoPay). Not started.
- **Notifications fan-out:** legacy uses `TBTaskQueue_*` (DB-backed queue). New repo currently emits synchronously — needs a queue when volume grows.
- **Asset storage:** new repo uses local disk (`uploads/`). Legacy uses `TBAWS` (S3). Switch before going live.
- **Affiliate commission compute parity:** `affiliate/utils/compute-amount.ts` matches legacy formula but lacks full parity tests against legacy fixture data. Outstanding in `[~] affiliate`.
- **Search:** legacy uses MySQL fulltext. New repo has no search yet. Postgres pg_trgm or external (Meilisearch / Typesense) — undecided.

---

## 9. How to extend this doc

When you discover something non-obvious during a session, add it here under the closest section. Keep entries short and cite the legacy file:line so the next session can verify. Don't paste long source — link via the file path; jcodemunch will fetch it on demand.
