# FE API Progression Tracker

Tracker for reconciling `docs/api-fe.md` (frozen FE contract, 61 endpoints) against current bb-backend-new implementation. Each item below is one PR-sized unit.

Status legend: `[ ]` pending · `[~]` in progress · `[x]` done · `[!]` blocked.

Source-of-truth contract: `docs/api-fe.md`.
Audit baseline: 24 ✅ · 17 ⚠️ · 14 ❌ · 6 🔴 + 1 global blocker (G1).

---

## Phase 0 — Global blocker

- [x] **G1** Response envelope migration → `{errCode, errMessage, data}` (2026-05-12)
  - `src/common/utils/response.util.ts` `ok()`/`fail()` rewritten.
  - `errCode: 0` on success, HTTP status on error.
  - `oauth/token` (#1) emits bare TokenBundleDto (no envelope) per FE contract.
  - OpenAPI schema + smoke tests updated.

---

## Phase P — Priority Queue (next sprint)

Ordered set of endpoints FE will smoke-test first: `/info`, `/logout`, product flow. Shipped 2026-05-12.

- [x] **P1** GET `/api/member/info` — authGuard → optionalAuthGuard. Anon/no-token returns base info (appName, appCode, maintenance, community). Member token still attaches profile + system extras. Files: `src/modules/member/member.routes.ts:11`, `member.controller.ts`.
  - ✅ **Follow-up T3.11 resolved (2026-05-12)**: backfill migration sets legacyId on BB-TIMELINE (999000001) + BB-EDUCATION (999000002). Controller drops UUID fallback, filters out null-legacyId rows. CommunityEntryDto.networkId typed `number`. Run `pnpm prisma:migrate` to apply.
- [x] **P2** POST `/api/member/account/logout` body — LogoutDto.deviceId → cloudMessagingId. FCM clear now filters by `fcmToken: dto.cloudMessagingId`. Files: `src/modules/account/dto/logout.dto.ts`, `account.service.ts:130-140`.
- [x] **P3** POST `/api/member/product/course/share` body — parse `code` not `productId`. Lookups product by code, emits real share URL (with affCode if member authed). DTO `ProductShareDto.productId → code`. Files: `src/modules/product/product.controller.ts:67-90`, `dto/product.dto.ts:326`.
- [x] **P4** GET `/api/member/product/list` envelope + perPage 100. New `okLegacy()` helper in `response.util.ts` emits `{meta:{total,page,lastPage}, data:[]}` (FE legacy http). `parsePagination()` now accepts `{perPage, maxPerPage}` defaults. Files: `src/common/utils/response.util.ts`, `pagination.util.ts`, `product.controller.ts:27-43`.
- [x] **P5** GET `/api/member/product/course/detail` — top-level `dataContent[]` flattened from `lessonsData[].courseLessonData[].slidesData[]`. Filters to `AudioTemplate`/`VideoTemplate` types; emits `{id, type, title, description, audio?, video?}` per FE contract. Reference: legacy `TBCourse/Lesson.php`. File: `src/common/serializers/index.ts::buildDataContent`.

Verified: `pnpm tsc --noEmit` clean. `pnpm test` 48/49 pass (1 unrelated pre-existing failure on empty country table).

---

## Phase 1 — Missing endpoints (🔴 ship-blocking)

Phone-register flow exists on FE but backend has zero endpoints. Without these, register UX broken.

- [ ] **T1.1** Implement `POST /api/member/auth/registerByPhone` (#2)
  - Body: `phone`, `phoneCode`, `name`, `password`. All required.
  - Response: `BaseResponse<dynamic>`.
  - Files: `src/modules/auth/auth.controller.ts`, `auth.service.ts`, `auth.routes.ts`, new DTO `dto/register-by-phone.dto.ts`.
  - Reuse: existing `authService.register` for password hash + member create. Spawn OTP record via `requestVerificationPhone` next step.

- [ ] **T1.2** Implement `POST /api/member/auth/requestVerificationPhone` (#3)
  - Body: `memberId`, `channel`. Response: `{member_id, phone, expired_date}`.
  - Files: same module + new `dto/request-verification-phone.dto.ts`.
  - Reuse: forgot-password OTP infrastructure in `auth.service.ts`. Channel field new (sms/whatsapp).

- [ ] **T1.3** Implement `POST /api/member/auth/validateOtpPhone` (#4)
  - Body: `memberId`, `verifyCode`. Response: `BaseResponse<dynamic>`.
  - Mirror legacy `validateOtp` (forgot-pw) — same OTP store, different field name (`memberId` not `email`).

---

## Phase 2 — Wrong response/body shape (❌)

One PR per module.

### Auth/Account

- [x] **T2.1** Fix preRegistration body (#7) — done 2026-05-12
  - DTO requires `name, phone, email, phoneCode, password, confirmation` (plus optional affiliateCode/networkId).
  - Service validates password == confirmation. `name`/`phoneCode`/`password` not persisted yet (PraMember has no columns) — FE re-sends on register step. Validated at boundary so bad payload fails fast.
  - Follow-up if needed: add columns to PraMember to persist these between pre-register and final register.
  - Files: `src/modules/account/dto/pre-registration.dto.ts`, `account.service.ts:76-115`.

- [x] **T2.2** Fix `auth/cloudMessaging` body (#40) — done 2026-05-12 (paired with T2.12)
  - `CloudMessagingDto` body: `{cloudMessagingId, deviceId?}`. cloudMessagingId stored as device.fcmToken.
  - When `deviceId` omitted: target most-recently-seen device for member (FE legacy single-device assumption).
  - 404 with explicit message when no device exists (points at /auth/devices).

- [ ] **T2.2-bis** Fix `account/logout` body (#6) — *promoted to P2*
  - Current: `{deviceId?, refresh_token?}`. FE sends: `{cloudMessagingId?}`.
  - Rename LogoutDto field; keep refresh-revoke + FCM-clear-by-token behavior.
  - File: `src/modules/account/dto/logout.dto.ts`, `account.service.ts:117-143`.

- [x] **T2.12** Emit `cloudMessagingId` in `/auth/devices` + `/auth/cloudMessaging` response (#36, #40) — done 2026-05-12
  - Both endpoints now emit `{cloudMessagingId, deviceId}`. `cloudMessagingId: string | null` (null when fcmToken absent on device row).
  - Closes FE historical "null" literal hang root cause (FE commit `dbc63de`). FE can now drop defensive `.toString()` coercion once stable.
  - New `DeviceEnrollmentResultDto` declares wire shape for Swagger.
  - Files: `src/modules/auth/auth.service.ts:301-340`, `dto/device.dto.ts`, `auth.controller.ts` ApiResponse decorators.

### Network

- [ ] **T2.3** Flatten network/member response (#26)
  - Current: `[{networkMember, member: {id, legacyId, email, fullName, ...}}]`.
  - Need flat: `[{memberId, name, provinceId, provinceName, cityId, cityName, email, phone, gender, isEmailVerified, isPhoneVerified, postalCode, imageUrl, coverUrl, biography, birthdate, address, dateRegister}]`.
  - File: `src/modules/network/network.service.ts:60-65` enrich step + new serializer. Profile join needed (province/city).

- [ ] **T2.4** Fix network/tag shape (#27)
  - Current: `{id, networkId, name}`. Need: `{tag, count, created}`.
  - File: `src/modules/network/network.service.ts:listTags` + DTO. `count` = posts-in-tag aggregate; `created` = tag firstSeenAt.

### Report

- [x] **T2.5** Rename report/category response fields (#28) — done 2026-05-12
  - Emit `{memberReportMemberCategoryId, id, category, description}`. `description` always null (no column yet on report_categories — follow-up migration if FE needs real value).
  - Body input parsing on `/report/memberReport` + `/post/report` still accepts both `categoryId` and `reportCategoryId` keys (unchanged).
  - Files: `src/modules/report/report.controller.ts`, `dto/report.dto.ts`.

### Product

- [ ] **T2.6** Switch product/course/share body key (#31)
  - Current: body `{productId}`. Need: body `{code}` (product code, not UUID).
  - File: `src/modules/product/product.controller.ts:share`, resolve product by code.

### Notification

- [ ] **T2.7** Fix notification/list shape (#32)
  - Field renames: `body` → `message`. `isSeen` boolean → int (0/1).
  - Pagination: default `perPage=50` (was 20).
  - Drop or hide extras (`notifGroup`, `payload`) — confirm with FE if breaking.
  - File: `src/modules/notification/dto/*`, `notification.service.ts`.

### Commission

- [x] **T2.8** Commission summary legacy fields (#46) — done 2026-05-12
  - Added `totalCommision` (= commission amount sum) + `totalTransactionSales` (= productPrice sum). FE legacy `CommisionModel` reads typo-preserved keys.
  - Modern `total`, `count`, `currency`, `recent` retained as extras.
  - Aggregation extended to sum `productPrice` alongside `amount` (single query).
  - Files: `src/modules/commission/commission.service.ts`, `dto/commission.dto.ts`.

### Location/Banner (legacy http envelope)

These 5 endpoints use FE legacy `http` layer. Envelope is `{meta:{total,page,lastPage}, data:[]}`, NOT G1 `{errCode, errMessage, data}`. Need branch in `ok()` or per-endpoint custom emission.

- [ ] **T2.9** Add legacy `{meta,data}` envelope helper
  - New: `src/common/utils/response.util.ts::okLegacy(res, rows, total, page, perPage)` emits `{meta: {total, page, lastPage}, data: rows}` directly (no `errCode` wrapper). FE legacy parser doesn't read BaseResponse for these.

- [ ] **T2.10** Convert location/country/province/city/district to legacy envelope (#49-52)
  - Items need int `id` (use `legacyId`), not UUID.
  - Add missing parent filters: city needs `countryId`+`provinceId`; district needs `countryId`+`provinceId`+`cityId`.
  - File: `src/modules/location/location.controller.ts` (lines 43, 66, 81, 96), serializers.

- [ ] **T2.11** Fix banner shape (#54)
  - Add `page`(default 1) + `perPage`(default 3) query parsing.
  - Field rename: `imageUrl` → `image: List<String>`, `linkUrl` → `link`, `id` = `tribeversityBannerId` int.
  - File: `src/modules/banner/banner.controller.ts:21`, serializer.

---

## Phase 3 — Partial drift (⚠️, low-risk renames)

Single sweep PR — minimal logic change, mostly field renames.

- [ ] **T3.1** Drop authGuard on `/member/info` (#5)
  - FE calls splash pre-login. File: `src/modules/auth/auth.routes.ts` (or wherever `/info` route bound).

- [x] **T3.2** Profile affiliateConnectedData null (#9) — verified 2026-05-12, no change needed
  - Audit `[]`-emit case was legacy tribelio backend behavior. New backend (`src/modules/profile/profile.controller.ts:29-43`) already emits `null` when `member.inviterId` is null; object `{memberNetworkConnectId, memberId, affiliatorCode, affiliatorMemberId}` when inviter present.
  - FE `_objectOrNull` custom converter remains as defensive scaffolding — can be dropped once FE confirms stability (audit §3.3).

- [x] **T3.3** Topic subscribe FE-shape response (#11) — done 2026-05-12
  - Response now `{memberId, topicId, isSubscribeTopic}` + extras `{status, action}` (FE-tolerant).
  - Bonus: service gained `resolveTopicByAnyId` (legacyId int OR UUID) — was broken when FE sent legacy int.
  - `memberId`/`topicId` emit `legacyId` int (nullable for new-only rows).
  - Files: `src/modules/topic/topic.service.ts`, `topic.controller.ts`, `dto/topic.dto.ts`.

- [x] **T3.4** Topic list accept `code` alias (#10) — done 2026-05-12
  - `?code=` query (FE primary) resolves via local `resolveNetworkId` (code → legacyId int → UUID). `?networkId=` kept as alias.
  - Resolver duplicated from `network.service` rather than cross-module import (services self-contained). TODO: extract to shared util when more modules need it.
  - Files: `src/modules/topic/topic.service.ts`, `topic.controller.ts`.

- [ ] **T3.5** Post list: surface `tag`, `sortBy`, `filter` query params (#12)
  - File: `src/modules/post/post.controller.ts:list`, service.

- [x] **T3.6** Like response shape (#14, #20) — done 2026-05-12
  - Both `/post/like` + `/comment/like` emit `{status: 'like'|'dislike', commentId: int|null, countLike: int}`.
  - `commentId` is `null` for post-like; `comment.legacyId` for comment-like.
  - Services return enum status + legacyId; controllers emit FE wire shape.
  - DTOs `PostLikeToggleResultDto` + `CommentLikeToggleResultDto` updated.
  - Files: `src/modules/post/post.{service,controller}.ts`, `src/modules/comment/comment.{service,controller}.ts`, both `dto/*.dto.ts`.

- [ ] **T3.7** Upload response wrap under `image` key + status bool (#34)
  - Current: `[UploadedItem]` with `status: 'success'` string. Need: `{image: [...] }` with `status: true|false`.
  - File: `src/modules/upload/upload.controller.ts:25`, DTO.

- [x] **T3.8** Auth register accept `name` alias (#38) — done 2026-05-12
  - `RegisterDto.fullName` decorated with `@Transform` (class-transformer): falls back to `obj.name` when `fullName` empty/absent.
  - FE legacy register flow `{name, email, password, phoneCode, phone?}` now works without backend change request.
  - File: `src/modules/auth/dto/register.dto.ts`.

- [x] **T3.9** Profile location response → full ProfileModel (#53) — done 2026-05-12
  - `updateLocation` now returns same shape as `/profile/info` (FE legacy parser reuses `ProfileModel`).
  - Extracted shared `serializeProfileLegacy` private method on controller — single source of truth.
  - File: `src/modules/profile/profile.controller.ts`.

- [ ] **T3.10** Product list legacy envelope + raise perPage default (#55)
  - Default perPage 100 (current 20). FE legacy parser expects `{meta, data}` envelope.
  - File: `src/modules/product/product.controller.ts:list`. Reuse T2.9 helper.

- [x] **T3.11** Canonicalize `/member/info` `community[].networkId` type — *P1 follow-up* (2026-05-12)
  - New migration `20260512100000_backfill_community_network_legacyid` sets legacyId on BB-TIMELINE (999000001) + BB-EDUCATION (999000002). High reserved ints to avoid legacy collision.
  - Controller (`member.controller.ts:43-48`) filters out null-legacyId networks, emits `networkId: n.legacyId` (typed `number`).
  - `CommunityEntryDto.networkId` schema: `number | string` → `number`.
  - `MemberInfoDto.memberId` drift (line 124) deferred to T4.x DTO sweep — member-extended path only, lower-risk.

---

## Phase 4 — Deep DTO field audits

PostDto + CommentDto + ProfileDto have 20-30 fields each with fallback chains. Verify field-by-field against contract.

- [ ] **T4.1** PostDto vs PostModel parity check
  - Contract: 32 fields incl. `postContentData{plain, linkData, attributeData[{index,type,data,text}], excerpt, excerptIndex}`, `embedData`, `topic`, `creator`, `video`, `havePolling`, `postUrl`, `postOriginalUrl`.
  - Compare to current `serializePost` in `src/modules/post/serializers/*`.

- [ ] **T4.2** CommentDto vs CommentModel parity
  - Confirm `timeAgo` (not `time_ago`), `countLikeInKilo`, `mentions[]`, `embedData` shape (currently `dynamic` FE-side — formalize).

- [ ] **T4.3** ProfileDto fallback canonicalization (per audit §3.1)
  - Pick ONE canonical name per field; drop fallback once FE stable. Coordinate with FE team — gated on FE confirm.

- [ ] **T4.4** ProductDto / ProductDetailModel fallback canonicalization
  - Same as T4.3 but for product fields. 14 fields with `??` chains.

- [x] **T4.5** Flatten course detail `dataContent` (#56) — shipped 2026-05-12 as **P5**
  - See P5 entry above. `buildDataContent` helper in `src/common/serializers/index.ts` flattens lessonsData→courseLessonData→slidesData filtering to Audio/Video templates.

---

## Phase 5 — Cleanup / contract decisions (gated on PM/FE)

- [ ] **T5.1** Decide on 4 UNUSED community CRUD endpoints (audit §3.6)
  - `member/post/create` (update mode), `member/post/delete`, `member/comment/update`, `member/comment/delete`.
  - PM confirms: keep (planned feature) or drop.

- [ ] **T5.2** Formalize `network/join` body (#25)
  - FE only sends `{code}`. Lock contract: any other fields?

- [ ] **T5.3** Audit naming typos (audit §3.5)
  - Backend already mirrors `commisionSummary`, `commisionFixAmount`. Decide: keep typo for compat (FE depends on key) OR rename + add alias.

- [x] **T5.4** Historical bug log — done 2026-05-12
  - Appended `§8.1 FE coercion history` section to `docs/legacy-analysis.md`. Captures the two `dbc63de` failure modes (InfoModel TypeError hang + cloudMessagingId "null" literal loop) and notes which backend tasks (T3.11, T2.12, P2) closed each loop.

---

## Critical files (cumulative)

- `src/common/utils/response.util.ts` (T2.9 legacy envelope helper)
- `src/modules/auth/*` (T1.1–T1.3, T2.2, T3.1, T3.8)
- `src/modules/account/*` (T2.1, T3.2, T3.9)
- `src/modules/network/network.service.ts` (T2.3, T2.4)
- `src/modules/report/*` (T2.5)
- `src/modules/product/*` (T2.6, T3.10)
- `src/modules/notification/*` (T2.7)
- `src/modules/commission/*` (T2.8)
- `src/modules/location/*` (T2.10)
- `src/modules/banner/*` (T2.11)
- `src/modules/topic/topic.controller.ts` (T3.3, T3.4)
- `src/modules/post/post.controller.ts` (T3.5, T3.6, T4.1)
- `src/modules/comment/comment.controller.ts` (T3.6, T4.2)
- `src/modules/upload/*` (T3.7)

## Verification per task

Each task should:
1. Pass `pnpm tsc --noEmit`.
2. Pass `pnpm test` (smoke + spec).
3. Add `tests/<feature>.contract.spec.ts` asserting wire-level JSON shape vs FE contract (specifically renamed/reshaped fields).
4. Re-run audit spot-check via curl after change.

## Out of scope

- Commerce/purchase/disbursement (per `docs/rewrite-progress.md` — not started).
- Mobile-side type drift fixes (FE pinned per audit).
- Affiliate payout compute (separate workstream).

---

## Session Log — 2026-05-12

11 commits this session. tsc clean + tests 54/55 (1 unrelated pre-existing empty-DB country failure) maintained throughout.

### Commits

| SHA | Scope | Summary |
|---|---|---|
| `4a3349f` | G1 | response envelope → `{errCode, errMessage, data}`; oauth/token unwrap |
| `9e5a5d9` | P1-P5 | /info authguard drop, logout body, product/share, product/list legacy envelope, dataContent flatten |
| `7a345c0` | docs | api-fe.md + fe-api-progression.md |
| `1633b72` | T3.11 | /info community networkId int canonicalize + backfill migration |
| `de8d3b9` | T3.6 | like response → `{status, commentId, countLike}` (post + comment) |
| `cd3db7e` | T3.8 | auth register accepts `name` alias for `fullName` |
| `b2015ca` | T3.3 | topic subscribe response → FE SubscribeModel shape + int-id resolver bonus |
| `106a98c` | T3.2 | verified backend already emits `null` correctly (no code change) |
| `e1d2a53` | T3.4 | topic list accepts `?code=` query alias |
| `99b9181` | T2.5 | report category fields → `{memberReportMemberCategoryId, category, description}` |
| `aa77487` | T2.8 | commission summary emits legacy `totalCommision` + `totalTransactionSales` |

### Tracker state after session

| Status | Count | Items |
|---|---|---|
| ✅ Shipped | 13 | G1, P1-P5, T3.11, T3.2, T3.3, T3.4, T3.6, T3.8, T2.5, T2.8 |
| 🔴 Missing | 3 | T1.1-T1.3 phone register/OTP |
| ❌ Wrong | 7 | T2.1, T2.2, T2.3, T2.4, T2.7, T2.10, T2.11, T2.12 |
| ⚠️ Partial | 4 | T3.5, T3.7, T3.9, T4.x DTO audits |
| Gated | 3 | T5.1, T5.2, T5.3 (PM/FE) |

### Required ops action

- `pnpm prisma:migrate` — apply `20260512100000_backfill_community_network_legacyid` to dev/staging/prod. Without it, T3.11 fix leaves `/info` `community` empty in any env where rows existed pre-backfill.

### FE-usable endpoints after this session

- All Retrofit endpoints: G1 envelope correct (`{errCode, errMessage, data}`)
- `oauth/token`: bare TokenBundleDto (no envelope) per contract
- `/member/info`: callable pre-login; anon/no-token returns base; `community[].networkId` always int
- `/account/logout`: body `{cloudMessagingId?}`
- `/product/course/share`: body `{code}`, real share URL
- `/product/list`: legacy `{meta, data}` envelope, perPage 100 default
- `/product/course/detail`: top-level `dataContent[]` flattened
- `/post/like` + `/comment/like`: emit `{status: 'like'\|'dislike', commentId: int\|null, countLike}`
- `/auth/register`: accepts `{name}` alias for `fullName`
- `/topic/subscribe`: emits `{memberId, topicId, isSubscribeTopic, status, action}`; legacy int IDs work
- `/topic/list?code=`: network code resolution
- `/report/category`: FE field names
- `/data/commisionSummary`: legacy `totalCommision` + `totalTransactionSales`

### Next priority candidates

Low-medium: T2.1 (preRegistration body), T2.2 (auth cloudMessaging body), T2.12 (cloudMessagingId response emit), T3.5, T3.7, T3.9.

Bigger: T1.1-T1.3 phone register flow, T2.3 network/member flatten, T2.4 network/tag count+created, T2.7 notification renames, T2.10 location envelope, T2.11 banner shape.
