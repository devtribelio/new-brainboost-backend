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

- [x] **T1.1** POST /api/member/auth/registerByPhone (#2) — done 2026-05-12
  - Creates unverified member from `{phone, phoneCode, name, password}`. Synthesizes placeholder `email = "phone-<code>-<num>@phone.brainboost.local"` (Member.email is NOT NULL; relax to nullable as follow-up).
  - Issues `verify-phone` OTP, target `phoneCode+phone`. SMS/WA dispatcher not wired — OTP logged via pino for dev. Returns `{member_id, phone, expired_date}`.
  - Files: `src/modules/auth/dto/register-by-phone.dto.ts` (new + `PhoneVerificationResponseDto`), `auth.service.ts:registerByPhone`, `auth.controller.ts`, `auth.routes.ts`.

- [x] **T1.2** POST /api/member/auth/requestVerificationPhone (#3) — done 2026-05-12
  - Body `{memberId, channel?}`. Resolves member by legacyId int OR UUID. Issues new `verify-phone` OTP. Returns `{member_id, phone, expired_date}`.
  - `channel` (sms/whatsapp) logged for future dispatcher integration.
  - 400 if member has no phone OR is already phone-verified.
  - Files: `dto/request-verification-phone.dto.ts` (new), `auth.service.ts:requestVerificationPhone`, controller/routes.

- [x] **T1.3** POST /api/member/auth/validateOtpPhone (#4) — done 2026-05-12
  - Body `{memberId, verifyCode}`. Consumes OTP via `otpService.consume(target, code, 'verify-phone')` (atomic — marks `usedAt`). Sets `member.isPhoneVerified=true`.
  - Files: `dto/validate-otp-phone.dto.ts` (new), `auth.service.ts:validateOtpPhone`, controller/routes.

- ⚠️ **T1.x follow-ups (not blocking ship):**
  - SMS/WhatsApp dispatcher (Twilio/Vonage/Fonnte) — OTPs currently logged-only.
  - `Member.email` relax to nullable (migration) OR add a `pendingEmail` column — drop synthetic placeholder.
  - `Notification.legacyId` and similar — separate follow-up.

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

- [x] **T2.2-bis** Fix `account/logout` body (#6) — shipped as **P2** (2026-05-12)
  - See P2 entry above. LogoutDto.deviceId → cloudMessagingId; FCM clear filters by token value.

- [x] **T2.12** Emit `cloudMessagingId` in `/auth/devices` + `/auth/cloudMessaging` response (#36, #40) — done 2026-05-12
  - Both endpoints now emit `{cloudMessagingId, deviceId}`. `cloudMessagingId: string | null` (null when fcmToken absent on device row).
  - Closes FE historical "null" literal hang root cause (FE commit `dbc63de`). FE can now drop defensive `.toString()` coercion once stable.
  - New `DeviceEnrollmentResultDto` declares wire shape for Swagger.
  - Files: `src/modules/auth/auth.service.ts:301-340`, `dto/device.dto.ts`, `auth.controller.ts` ApiResponse decorators.

### Network

- [x] **T2.3** Flatten network/member response (#26) — done 2026-05-12
  - Response flat: `{memberId, name, provinceId, provinceName, cityId, cityName, email, phone, gender, isEmailVerified (0/1), isPhoneVerified (0/1), postalCode, imageUrl, coverUrl, biography, birthdate, address, dateRegister}`.
  - Service includes member.profile with province + city relations (each via legacyId+name).
  - New `serializeNetworkMemberLegacy(member, joinedAt)` helper in `src/common/serializers/index.ts`.
  - `NetworkMemberEntryDto` rewritten flat.
  - Files: `src/modules/network/network.service.ts`, `network.controller.ts`, `dto/network.dto.ts`, `src/common/serializers/index.ts`.

- [x] **T2.4** Network/tag shape `{tag, count, created}` (#27) — done 2026-05-12
  - **Schema change**: `NetworkTag.createdAt DateTime @default(now())` added. Migration `20260512200000_network_tag_created_at` backfills existing rows to current timestamp.
  - Service: per-tag post count via naive `content contains '#<tag>'` (no PostTag relation; symmetric with T3.5 hashtag-match). O(page-size) parallel counts, acceptable for default perPage <= 50. Returned via `countByTag` Map.
  - Response items: `{tag: name, count, created: createdAt.toISOString()}`.
  - NetworkTagDto rewritten.
  - Files: `prisma/schema.prisma`, `prisma/migrations/20260512200000_*/migration.sql`, `src/modules/network/network.service.ts`, `network.controller.ts`, `dto/network.dto.ts`.

### Report

- [x] **T2.5** Rename report/category response fields (#28) — done 2026-05-12
  - Emit `{memberReportMemberCategoryId, id, category, description}`. `description` always null (no column yet on report_categories — follow-up migration if FE needs real value).
  - Body input parsing on `/report/memberReport` + `/post/report` still accepts both `categoryId` and `reportCategoryId` keys (unchanged).
  - Files: `src/modules/report/report.controller.ts`, `dto/report.dto.ts`.

### Product

- [x] **T2.6** Switch product/course/share body key (#31) — shipped as **P3** (2026-05-12)
  - See P3 entry above. Body `{code}`, real share URL with optional affCode.

### Notification

- [x] **T2.7** Notification/list shape (#32) — done 2026-05-12
  - Field shape: `{notificationId, title, message, isSeen (0/1 int), created, updated, refTable, refId, type}`.
  - `updated` derived from `readAt ?? createdAt` (ISO string).
  - `refTable` + `refId` derived from `payload` JSON (recognizes `commentId`/`postId`/`replyId`/`memberId` keys).
  - Default perPage 50 (was 20). Dropped extras (`id`, `body`, `payload`, `seenAt`, `createdAt`, `notifGroup`).
  - NotificationDto schema rewritten.
  - `notificationId` stays UUID until `Notification.legacyId` column added (deferred — no current legacy data to migrate).
  - Files: `src/common/serializers/index.ts`, `src/modules/notification/notification.controller.ts`, `dto/notification.dto.ts`.

### Commission

- [x] **T2.8** Commission summary legacy fields (#46) — done 2026-05-12
  - Added `totalCommision` (= commission amount sum) + `totalTransactionSales` (= productPrice sum). FE legacy `CommisionModel` reads typo-preserved keys.
  - Modern `total`, `count`, `currency`, `recent` retained as extras.
  - Aggregation extended to sum `productPrice` alongside `amount` (single query).
  - Files: `src/modules/commission/commission.service.ts`, `dto/commission.dto.ts`.

### Location/Banner (legacy http envelope)

These 5 endpoints use FE legacy `http` layer. Envelope is `{meta:{total,page,lastPage}, data:[]}`, NOT G1 `{errCode, errMessage, data}`. Need branch in `ok()` or per-endpoint custom emission.

- [x] **T2.9** Add legacy `{meta,data}` envelope helper — shipped as **P4** (2026-05-12)
  - See P4 entry above. `okLegacy()` lives in `src/common/utils/response.util.ts`; consumed by location/banner/product-list.

- [x] **T2.10** Location 4 endpoints → legacy envelope (#49-52) — done 2026-05-12
  - All 4 endpoints (country/province/city/district) emit `okLegacy` envelope `{meta:{total,page,lastPage}, data:[]}`.
  - Items shape: `{id: legacyId, [parent legacyIds], name}` per FE legacy spec. Serializers updated with proper relation includes (province→country, city→province→country, district→city→province→country).
  - Added parent filter plumbing: city accepts `countryId`+`provinceId`; district accepts `countryId`+`provinceId`+`cityId`.
  - Files: `src/modules/location/location.controller.ts`, `location.service.ts`, `src/common/serializers/index.ts` (4 serializers).

- [x] **T2.11** Banner shape + pagination (#54) — done 2026-05-12
  - Pagination added (default perPage 3). Switched to `okLegacy` envelope.
  - Serializer emits FE BannerModel: `{id: legacyId int, client: title, link: linkUrl, image: [imageUrl]}`. Dropped position/isActive extras.
  - Files: `src/modules/banner/banner.controller.ts`, `banner.service.ts`, `src/common/serializers/index.ts`.

---

## Phase 3 — Partial drift (⚠️, low-risk renames)

Single sweep PR — minimal logic change, mostly field renames.

- [x] **T3.1** Drop authGuard on `/member/info` (#5) — shipped as **P1** (2026-05-12)
  - See P1 entry above. authGuard → optionalAuthGuard; anon/no-token returns base info.

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

- [x] **T3.5** Post list query params (#12) — done 2026-05-12
  - Controller parses `tag`, `sortBy`, `filter`. Service applies:
    - `tag`: naive `#hashtag` contains match against `post.content` (no PostTag relation in schema). `keyword` wins when both set.
    - `sortBy`: `newest` (default) | `oldest` | `popular`. Unknown → newest.
    - `filter`: `pinned` → `where.isPinned`, `recent-engagement` → orderBy engagedAt desc. Unknown → no-op.
  - `@ApiQuery` decorators added for Swagger.
  - Files: `src/modules/post/post.service.ts`, `post.controller.ts`.

- [x] **T3.6** Like response shape (#14, #20) — done 2026-05-12
  - Both `/post/like` + `/comment/like` emit `{status: 'like'|'dislike', commentId: int|null, countLike: int}`.
  - `commentId` is `null` for post-like; `comment.legacyId` for comment-like.
  - Services return enum status + legacyId; controllers emit FE wire shape.
  - DTOs `PostLikeToggleResultDto` + `CommentLikeToggleResultDto` updated.
  - Files: `src/modules/post/post.{service,controller}.ts`, `src/modules/comment/comment.{service,controller}.ts`, both `dto/*.dto.ts`.

- [x] **T3.7** Upload response wrap (#34) — done 2026-05-12
  - Response: `{image: [UploadedFileDto[]]}`. `status` now boolean (`true` on success). New `UploadedFilesWrapperDto` for Swagger.
  - Files: `src/modules/upload/upload.service.ts`, `upload.controller.ts`, `dto/upload.dto.ts`.

- [x] **T3.8** Auth register accept `name` alias (#38) — done 2026-05-12
  - `RegisterDto.fullName` decorated with `@Transform` (class-transformer): falls back to `obj.name` when `fullName` empty/absent.
  - FE legacy register flow `{name, email, password, phoneCode, phone?}` now works without backend change request.
  - File: `src/modules/auth/dto/register.dto.ts`.

- [x] **T3.9** Profile location response → full ProfileModel (#53) — done 2026-05-12
  - `updateLocation` now returns same shape as `/profile/info` (FE legacy parser reuses `ProfileModel`).
  - Extracted shared `serializeProfileLegacy` private method on controller — single source of truth.
  - File: `src/modules/profile/profile.controller.ts`.

- [x] **T3.10** Product list legacy envelope + raise perPage default (#55) — shipped as **P4** (2026-05-12)
  - See P4 entry above. `okLegacy` envelope, perPage 100 default.

- [x] **T3.11** Canonicalize `/member/info` `community[].networkId` type — *P1 follow-up* (2026-05-12)
  - New migration `20260512100000_backfill_community_network_legacyid` sets legacyId on BB-TIMELINE (999000001) + BB-EDUCATION (999000002). High reserved ints to avoid legacy collision.
  - Controller (`member.controller.ts:43-48`) filters out null-legacyId networks, emits `networkId: n.legacyId` (typed `number`).
  - `CommunityEntryDto.networkId` schema: `number | string` → `number`.
  - `MemberInfoDto.memberId` drift (line 124) deferred to T4.x DTO sweep — member-extended path only, lower-risk.

---

## Phase 4 — Deep DTO field audits

PostDto + CommentDto + ProfileDto have 20-30 fields each with fallback chains. Verify field-by-field against contract.

- [x] **T4.1** PostDto vs PostModel parity — done 2026-05-12
  - Added all 32 FE PostModel fields. Net additions to `serializePost`:
    - `postContentData` (rich): `{plain, linkData:[], attributeData:[], excerptIndex:null, excerpt}` — placeholder until rich-content stored in schema.
    - `contentTitle` (alias of title), `embed` (alias of embedUrl), `fullContent` (= content), `embedData` (null — no OG parser).
    - `attachments:[]`, `audios:[]` (schema gaps — null/empty).
    - `memberIdPost` = author legacyId, `video` = `{url, platform: youtube|bunnycdn|other}` via URL detection, `videoThumbnailUrl: null`.
    - `starred: null`, `havePolling: 0` (schema gaps).
    - `timeAgo`/`dateAgo` via T4.2 helpers, `pinned` 0/1 from `isPinned` bool.
    - `topic` reshaped to FE PostTopicModel `{topicId, topicName, topicType, topicIcon}` (was full TopicDto).
    - `creator` new PostCreatorModel `{memberId, name, profileImage, profileCoverImage}`.
    - `canEdit`/`canDelete` viewer-driven (true when `req.user.id === post.authorId`).
    - `isJoined` caller-controlled (set by post.controller per viewer membership; null if not provided).
    - `postUrl`/`postOriginalUrl` built from `PUBLIC_WEB_URL`.
    - `publishStatus` surfaced (was missing).
  - `serializePost(p, statusLike, { viewerId, isJoined })` signature extended.
  - Backend extras retained (`id`, `memberId` int, `networkId`, `topicId`, `countReplies`, `viewCount`, `videoUrl`, `isDeleted`, `createdAt`, `updatedAt`, `member`).
  - Helpers reused: `timeAgoString`, `dateAgoString` (from T4.2).
  - PostDto schema fully rewritten with nested `PostContentDataDto`, `PostTopicDto`, `PostCreatorDto`, `PostVideoDto`.
  - Files: `src/common/serializers/index.ts`, `src/modules/post/dto/post.dto.ts`.

- [x] **T4.2** CommentDto vs CommentModel parity — done 2026-05-12
  - Added 14 missing FE fields: `memberName`, `memberProfileImage`, `embed`, `embedUrl`, `embedData`, `fullContent`, `image`, `audio`, `timeAgo`, `dateAgo`, `countLikeInKilo`, `replyCount`, `mentions[]`, plus `replyId`/`postId`/`memberId` as int (legacyId).
  - `timeAgo` / `dateAgo` computed via new helpers (`timeAgoString`, `dateAgoString`) — formats: `just now`, `Xm/h/d/w/mo/y`, `Today`/`Yesterday`/`DD Mon`/`DD Mon YYYY`.
  - `mentions` parsed from content via `@[\w]+` regex.
  - `image` = first of `imageUrls[]` (FE expects singular dynamic). Multi-image legacy extra kept under `images`.
  - `embed`/`embedUrl`/`embedData`/`audio` emit null — Comment schema has no columns. Follow-up if FE needs.
  - commentInclude extended: `parent.legacyId` + `post.legacyId` so `replyId`/`postId` are int.
  - Backend extras (`id`, `parentId`, `images`, `isDeleted`, `createdAt`, `updatedAt`, `member`) retained — FE ignores unknown keys.
  - Files: `src/common/serializers/index.ts`, `comment.service.ts:commentInclude`, `dto/comment.dto.ts`.

- [x] **T4.3** ProfileDto fallback canonicalization (per audit §3.1) — done 2026-05-12
  - `serializeProfileLegacy` rewritten to emit FE ProfileModel canonical names only:
    - `image` (drop `imageUrl`, `avatarUrl`, `memberImageUrl`)
    - `bio` (drop `biography`)
    - `phoneNumber` / `phoneCode` (string)
    - `country/province/city/districtId` (string per audit §3.2)
  - Dropped extras not in FE ProfileModel: `id`, `code`, `email`, `coverUrl`, `gender`, `birthdate`, `isActive`, `isVerified`, `isEmailVerified`, `isPhoneVerified`, `dateRegister`, `createdAt`, raw `profile` nested.
  - `serializeMemberFull` left untouched — still used by `/profile/update` and network/member elsewhere (different FE models read aliases there).
  - MemberProfileDto schema rewritten — declares only canonical fields.
  - FE can retire `??` fallback chains for ProfileModel.image and ProfileModel.bio once tested against this response.
  - Files: `src/modules/profile/profile.controller.ts:serializeProfileLegacy`, `dto/profile.dto.ts:MemberProfileDto`.

- [x] **T4.4** ProductDto canonicalization (per audit §3.1) — done 2026-05-12
  - `serializeProduct` (list): dropped 13 fallback aliases (`id`, `productId`, `type`, `typeLabel`, `code`, `slug`, `title`, `description`, `thumbnail`, `price`, `updatedAt`, `isActive`, `createdAt`). Backend now emits **only** canonical (leftmost) names:
    - `networkAccountProductAffiliatorId` (id), `productType`, `productTypeLabel`, `productCode`, `productSlug`, `productName`, `productCategory`, `productPrice`, `productImageUrl`, `lastUpdated`, `productPaymentUrl`, `productShareDetailUrl`, `commisionFixAmount` (sic), `productUrl`, `isPurchased`, `productRatingAvg`.
  - `serializeCourseDetailLegacy` (detail): already canonical from earlier P5 commit. No change.
  - ProductDto schema rewritten — declares only canonical fields. Doc strings note FE-side fallback retire path.
  - FE can drop `??` chains on ProductModel once tested.
  - Files: `src/common/serializers/index.ts:serializeProduct`, `src/modules/product/dto/product.dto.ts:ProductDto`.

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

19 commits this session. tsc clean + `pnpm test` 55/55 (pre-existing empty-DB country test cleared once envelope shape change in T2.10 made the assertion logical).

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
| `40da277` | docs | session log v1 |
| `a8c5f77` | T3.9 + T2.1 + T4.5 + T5.4 | tier 3 sweep — profile/location response, preRegistration body, bookkeeping, historical bug log |
| `31d1705` | T3.7 + T3.5 | tier 6 — upload response wrap + post list query params |
| `c7f180e` | T2.2 + T2.12 | auth/FCM cloudMessagingId pair (body + response) |
| `93397bc` | T2.10 + T2.11 | tier 4 — location envelope + parent filters + banner shape |
| `3e5a71c` | T2.3 + T2.4 | tier 5 — network/member flatten + network/tag count + created (with migration) |
| `2943ad2` | T2.7 | notification list → FE NotificationModel shape |
| `ea46e71` | docs | session log v2 |
| `1250ad5` | T1.1 + T1.2 + T1.3 | phone-register / OTP trio — closes last 🔴 |
| `82b0645` | docs | legacy-providers.md — external integration follow-up tracker |

### Tracker state after session

| Status | Count | Items |
|---|---|---|
| ✅ Shipped | 29 | G1, P1-P5, T1.1, T1.2, T1.3, T2.1-T2.12, T3.1-T3.11, T4.5, T5.4 |
| 🔴 Missing | 0 | — all phone-register/OTP shipped this session |
| ❌ Wrong | 0 | — all ❌ items closed this session |
| ⚠️ Partial | 4 | T4.1, T4.2, T4.3, T4.4 (DTO parity audits — FE-gated for canonicalization) |
| Gated | 3 | T5.1, T5.2, T5.3 (PM/FE decisions) |
| T1.x follow-ups | 2 | Qontak dispatcher + Member.email relax-to-nullable (logged in `docs/legacy-providers.md`) |

### Required ops action

Two migrations created this session — apply on dev/staging/prod via `pnpm prisma:migrate`:

1. `20260512100000_backfill_community_network_legacyid` — backfills BB-TIMELINE/BB-EDUCATION legacyId. Required for T3.11 (/info `community[].networkId` int). Without it, `/info` `community` is empty in envs with the pre-fix seed.
2. `20260512200000_network_tag_created_at` — adds `NetworkTag.createdAt`. Required for T2.4 (/network/tag emits `created`). Without it, `/network/tag` 500s.

### FE-usable endpoints after this session

**Retrofit layer (G1 envelope `{errCode, errMessage, data}`):**
- `oauth/token`: bare TokenBundleDto (no envelope) per contract
- `/member/info`: callable pre-login (anon/no-token → base; member-scope adds profile + system); `community[].networkId` int
- `/auth/devices`, `/auth/cloudMessaging`: emit `{cloudMessagingId, deviceId}`; body accepts `{cloudMessagingId}`
- `/auth/register`: accepts `{name}` alias for `fullName`
- `/auth/registerByPhone`: `{phone, phoneCode, name, password}` → creates unverified Member + issues `verify-phone` OTP (logged via pino — no SMS/WA dispatcher yet)
- `/auth/requestVerificationPhone`: `{memberId, channel?}` → re-issues OTP; returns `{member_id, phone, expired_date}`
- `/auth/validateOtpPhone`: `{memberId, verifyCode}` → marks `isPhoneVerified=true`
- `/account/preRegistration`: requires `{name, phone, email, phoneCode, password, confirmation}`
- `/account/logout`: body `{cloudMessagingId?}`
- `/account/profile/location`: returns full ProfileModel (same as `/profile/info`)
- `/topic/list?code=BB-TIMELINE`: network code resolution
- `/topic/subscribe`: `{memberId, topicId, isSubscribeTopic, status, action}`, accepts int IDs
- `/post/list`: query params `tag` / `sortBy` / `filter` supported
- `/post/like` + `/comment/like`: emit `{status: 'like'|'dislike', commentId: int|null, countLike}`
- `/network/member`: flat FE NetworkMemberModel (16 fields)
- `/network/tag`: `{tag, count, created}`
- `/notification/list`: FE NotificationModel `{notificationId, title, message, isSeen 0/1, created, updated, refTable, refId, type}`; perPage default 50
- `/report/category`: FE field names
- `/upload/temporary`: `{image: [{...status:bool}]}`
- `/product/course/share`: body `{code}`, real share URL
- `/product/course/detail`: top-level `dataContent[]` flattened

**Legacy http layer (bare `{meta:{total,page,lastPage}, data:[]}`):**
- `/product/list`: perPage 100 default, ProductModel field aliases
- `/data/location/country|province|city|district`: int `id`, parent filters supported
- `/data/banner`: `{id:int, client, link, image:[url]}`, pagination
- `/data/commisionSummary`: legacy `totalCommision` + `totalTransactionSales`

### Next priority candidates

**T1.x follow-ups (production-readiness for phone-register):**
- **T1.4** Qontak WhatsApp dispatcher — wire `qontak.service.ts`, hook into `otpService.issue` for phone targets. Details + hardcoded IDs documented in `docs/legacy-providers.md`.
- **T1.5** TTL tighten (10 → 2 min) + resend cooldown + 5/day rate limit for parity with legacy Qontak constraints.
- **T1.6** Relax `Member.email` to nullable (migration) — drop synthetic placeholder.

**Phase 4 DTO audits (FE-coordination required for fallback choices):**
- T4.1 PostDto vs PostModel (32 fields)
- T4.2 CommentDto parity
- T4.3 ProfileDto canonicalization
- T4.4 ProductDto canonicalization

**Phase 5 cleanup gated on PM/FE input:**
- T5.1 (drop 4 unused community CRUD endpoints)
- T5.2 (formalize /network/join body)
- T5.3 (naming typo decisions)

### Related docs

- `docs/api-fe.md` — frozen FE contract (61 endpoints).
- `docs/legacy-providers.md` — external integrations not yet wired (Qontak, Bunny, S3, FCM, etc.).
- `docs/legacy-analysis.md` — symbol-level legacy mapping + §8.1 FE coercion history.
