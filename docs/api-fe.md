# API Contract Audit — brainboost-apps

## Context

The backend team is mid-overhaul and needs a frozen snapshot of the contract the Flutter app expects today: every endpoint, every field name, every fallback, every type. This document is that snapshot — meant to be the working input for designing the new contract, not an aspirational design.

Scope is read-only — no code changes proposed. Two parallel API layers exist in the app:

- **Modern (Retrofit)** — `lib/core/network/remote/**/*_remote_source.dart` → repositories → use cases → BLoCs/Cubits. All responses wrapped in `BaseResponse<T>`.
- **Legacy (raw `http`)** — `lib/shared/api/services/*.dart`, URLs in [api_connection.dart](lib/shared/api/api_connection.dart). Still live; consumed by ViewModels and shared cubits. Migration is in flight.

Some paths are served by **both** layers (legacy + Retrofit hit the same endpoint). Those duplicates are called out — the backend can treat each path as one contract; the legacy callers will be removed as MVVM→BLoC migration proceeds.

---

## Global Envelopes

### `BaseResponse<T>` (Retrofit layer)
```
errCode:    int?
errMessage: String?
data:       T?
```
Every Retrofit endpoint **except** `oauth/token` returns this envelope.

### `PaginationModel<T>` (Retrofit layer)
```
total:       dynamic     // server returns int or string inconsistently
lastPage:    dynamic
perPage:     dynamic
currentPage: dynamic
timestamp:   dynamic
items:       List<T>?
```
> ⚠ The `dynamic` typing on numeric fields is itself a contract issue — backend should standardize to `int`.

### Legacy pagination (raw http layer)
```
totalData:   int   (from meta.total)
currentPage: int   (from meta.page)
totalPage:   int   (from meta.lastPage)
data:        List<T>
```
> Different envelope from the Retrofit pagination — same backend may already be returning both shapes via different endpoints.

---

## Used vs Unused — Summary

61 endpoints declared across both layers; **6 unused** (no call site in `lib/`):

| Endpoint | Layer | Why unused |
|---|---|---|
| POST `member/post/create` (updatePost) | Retrofit | UseCase + DI registered, no caller |
| POST `member/post/delete` | Retrofit | UseCase + DI registered, no caller |
| POST `member/comment/update` | Retrofit | UseCase + DI registered, no caller |
| POST `member/comment/delete` | Retrofit | UseCase + DI registered, no caller |
| POST `/member/oauth/refresh` | Legacy | Declared, never referenced — token refresh appears unimplemented |
| GET `/member/info` (legacy `appInfoUrl`) | Legacy | Superseded by Retrofit `member/info`; only a commented-out reference remains |

Worth flagging beyond the dead list:
- Community CRUD (post/comment update+delete) has full scaffolding — either planned for after migration or a cut feature. Confirm with PM.
- Missing token-refresh means short-lived tokens in the new backend will manifest as silent logouts.

---

# Part 1 — Modern Retrofit Endpoints

## 1.1 Auth — [auth_remote_source.dart](lib/core/network/remote/auth/auth_remote_source.dart)

### 1. POST `/member/oauth/token` — `oauthToken()`
Exchange credentials (password / social / refresh) for an access token. **Returns `TokenModel` directly — no `BaseResponse` wrapper.**

**Body (`TokenRequest`):**
| Field | Type | Required |
|---|---|---|
| `client_id` | String | ✓ |
| `client_secret` | String | ✓ |
| `grant_type` | String | ✓ (`password` \| `social` \| `client_credentials` \| `refresh_token`) |
| `username` | String? | when `grant_type=password` |
| `password` | String? | when `grant_type=password` |
| `access_token` | String? | when `grant_type=social` |
| `provider` | String? | when `grant_type=social` |
| `refresh_token` | String? | when `grant_type=refresh_token` (not currently called) |

**Response (`TokenModel`):** `token_type`, `expires_in` (int), `access_token`, `refresh_token` — all nullable.

---

### 2. POST `/member/auth/registerByPhone` — `registerByPhone()`
Register a new account by phone (new flow, replaces legacy email register).

**Body (`RegisterByPhoneRequest`):** `phone`, `phoneCode`, `name`, `password` — all String, required.
**Response:** `BaseResponse<dynamic>`.

---

### 3. POST `/member/auth/requestVerificationPhone` — `requestVerificationPhone()`
Send OTP to the user's phone. Used in register flow and resend-OTP.

**Body (`RequestVerificationPhoneRequest`):** `memberId` (String), `channel` (String) — required.
**Response (`BaseResponse<PhoneVerificationResponse>`):**
| Field | Type | Notes |
|---|---|---|
| `member_id` | int? | custom converter — backend returns either int or string |
| `phone` | String? |  |
| `expired_date` | String? |  |

---

### 4. POST `/member/auth/validateOtpPhone` — `validateOtpPhone()`
Validate the OTP submitted by the user.

**Body (`ValidateOtpPhoneRequest`):** `memberId` (String), `verifyCode` (String) — required.
**Response:** `BaseResponse<dynamic>`.

---

### 5. GET `/member/info` — `info()`
App-startup probe: returns maintenance state and the community/network the user belongs to. Called from splash, login, and on app resume.

No params.
**Response (`BaseResponse<InfoModel>`):**
| Field | Type | Notes |
|---|---|---|
| `appName` | String? |  |
| `appCode` | String? |  |
| `affiliatePlatformUrl` | String? |  |
| `maintenance` | int? (0/1) | ⚠ **type drift** — `InfoModel.fromJson` coerces string→int because the new backend has been sending it as a string. Once contract stabilizes the coercion can be removed. |
| `maintenanceMessage` | String? |  |
| `maintenanceEndDateTime` | String? |  |
| `community` | `List<InfoCommunityModel>?` |  |

**`InfoCommunityModel`:** `page`, `networkId` (int — ⚠ same type-drift coercion as `maintenance`, backend returns string-encoded int), `networkCode`, `name`.

> Duplicates legacy `appInfoUrl` (commented-out in `auth_service.dart`).
> Past failure mode (fixed in `dbc63de`, 2026-05-12): backend returned `maintenance`/`networkId` as strings, which threw an uncaught `TypeError` from `_$InfoModelFromJson`. `TypeError` doesn't extend `Exception` so `on Exception` clauses in the repo layer didn't catch it, and the future never resolved — every `/member/info` call (splash, login, app resume) hung indefinitely. Backend should pick one type and stick to it.

---

### 6. POST `/member/account/logout` — `logout()`
Logout + deregister FCM token.

**Body:** `cloudMessagingId` (String?) — single optional field.
**Response:** `BaseResponse<dynamic>`.

> Duplicates legacy `logoutUrl` (still active in `AuthService.logout`).

---

## 1.2 Account — [account_remote_source.dart](lib/core/network/remote/account/account_remote_source.dart)

### 7. POST `/member/account/preRegistration` — `preRegistration()`
Pre-register a user (collect data before full verification). Called from the first-time register flow.

**Body (`PreRegistrationRequest`):** `name`, `phone`, `email`, `phoneCode`, `password`, `confirmation` — all String, required.
**Response:** `BaseResponse` (no data).

---

### 8. POST `/member/account/affiliateConnect` — `affiliateConnect()`
Link the current account to an affiliator via referral code.

**Body:** `affiliatorCode` (String, required).
**Response:** `BaseResponse` (no data).

---

### 9. GET `/member/account/profile/info` — `profileInfo()`
Fetch the authenticated user's profile.

No params.
**Response (`BaseResponse<ProfileModel>`):**
| Field | Type | Notes |
|---|---|---|
| `memberId` | int? |  |
| `image` | String? | ⚠ **fallback chain** in legacy parser — see Part 2 |
| `name` | String? |  |
| `phoneNumber` | String? | custom converter `_stringFromDynamic` (int↔string drift) |
| `phoneCode` | String? | custom converter |
| `firstName`, `lastName` | String? |  |
| `postalCode` | String? | custom converter |
| `countryId` / `provinceId` / `cityId` / `districtId` | String? | custom converter (backend returns either int or string) |
| `countryName` / `provinceName` / `cityName` / `districtName` | String? |  |
| `bio` | String? | ⚠ **fallback** in legacy parser (`bio` ↔ `biography`) |
| `address` | String? |  |
| `isPreRegister` | int? |  |
| `loginCount` | int? |  |
| `isDeleted` | int? |  |
| `affiliatorCode` | String? |  |
| `haveAffiliateConnect` | bool? |  |
| `affiliateConnectedData` | `ProfileAffiliateConnectedData?` | ⚠ backend returns either an object OR an empty list `[]` — custom converter normalizes |

**`ProfileAffiliateConnectedData`:** `memberNetworkConnectId`, `memberId`, `affiliatorCode`, `affiliatorMemberId` (all int?/String?).

> Duplicates legacy `profileUrl` (still consumed by `ProfileService.fetchProfile`).

---

## 1.3 Community — [community_remote_source.dart](lib/core/network/remote/community/community_remote_source.dart)

### 10. GET `member/topic/list` — `topics()`
Paginated topics within a network.

**Query (`TopicsQueryRequest.toJson()`):** `page?`, `perPage?`, `code` (network code, required), `keyword?`.
**Response (`BaseResponse<PaginationModel<TopicModel>>`):**
`TopicModel`: `topicId` (int?), `name`, `icon`, `iconType`, `type`, `countPost` (int?), `orderNumber` (int?), `isSubscribeTopic` (bool?).

---

### 11. POST `member/topic/subscribe` — `subscribeToTopic()`
Subscribe/unsubscribe a topic (server toggles based on current state — return value's `isSubscribeTopic` reflects the new state).

**Body (`TopicSubscribeRequest`):** `topicId` (int, required).
**Response (`BaseResponse<SubscribeModel>`):** `memberId` (int?), `topicId` (int?), `isSubscribeTopic` (bool?).

---

### 12. GET `member/post/list` — `posts()`
Paginated post feed. Used by main community feed, topic detail, education page, and hashtag detail.

**Query (`PostsQueryRequest.toJson()`):**
| Key | Type | Required |
|---|---|---|
| `page` / `perPage` | int? | optional |
| `code` | String | ✓ network code |
| `topicId` | int? | optional |
| `tag` | String? | optional |
| `sortBy` | String? | optional |
| `keyword` | String? | optional |
| `filter` | String? | optional |

**Response:** `BaseResponse<PaginationModel<PostModel>>`. See **PostModel** in §1.7.

---

### 13. GET `member/post/detail` — `postDetail()`
Single post by ID. Used by deep links from FCM, notifications, and detail navigation.

**Query:** `postId` (String, required).
**Response:** `BaseResponse<PostModel>`. See §1.7.

---

### 14. POST `member/post/like` — `likePost()`
Toggle like on a post. Used by post item, comment item, feed image viewer.

**Body:** `postId` (int, required).
**Response (`BaseResponse<LikeModel>`):** `status` (String?), `commentId` (int?), `countLike` (int?).

---

### 15. POST `member/post/create` — `createPost()`
Create a new post.

**Body:**
| Key | Type | Required |
|---|---|---|
| `code` | String | ✓ network code |
| `content` | String | ✓ |
| `embedUrl` | String? | optional |
| `topicId` | int? | optional |
| `images` | `List<ImageRequest>?` | optional — each `ImageRequest = { fileId: String }` |

**Response:** `BaseResponse<dynamic>`.

---

### 16. POST `member/post/create` — `updatePost()` ⚠ **UNUSED**
Same path as createPost but with `postId` to distinguish update from create.

**Body:** `postId` (int, required), `content` (String, required), `topicId` (int?).
**Response:** `BaseResponse<dynamic>`.
> Backend collapses create+update into one endpoint; consider splitting in the new contract.

---

### 17. POST `member/post/delete` — `deletePost()` ⚠ **UNUSED**
**Body:** `postId` (int, required). **Response:** `BaseResponse<dynamic>`.

---

### 18. GET `member/comment/list` — `comments()`
Paginated comments for a post.

**Query:** `page` (int), `perPage` (int), `postId` (int), `sortBy` (String) — all required.
**Response:** `BaseResponse<PaginationModel<CommentModel>>`. See **CommentModel** in §1.7.

---

### 19. GET `member/comment/detail` — `commentDetail()`
Single comment by ID. Used by notification deep links.

**Query:** `commentId` (int, required). **Response:** `BaseResponse<CommentModel>`.

---

### 20. POST `member/comment/like` — `likeComment()`
**Body:** `commentId` (int, required). **Response:** `BaseResponse<LikeModel>` (same shape as likePost).

---

### 21. POST `member/comment/create` — `createComment()`
Create a comment or reply.

**Body:** `postId` (int, required), `content` (String, required), `replyId` (int?, optional — present when it's a reply to another comment).
> ⚠ **Dart parameter naming bug**: the Dart parameter is named `topicId` but maps to the `replyId` body key. Cosmetic only — wire-level field is `replyId`.

**Response:** `BaseResponse<dynamic>`.

---

### 22. POST `member/comment/update` — `updateComment()` ⚠ **UNUSED**
**Body:** `commentId` (int), `content` (String). **Response:** `BaseResponse<dynamic>`.

---

### 23. POST `member/comment/delete` — `deleteComment()` ⚠ **UNUSED**
**Body:** `commentId` (int). **Response:** `BaseResponse<dynamic>`.

---

### 24. GET `member/reply/list` — `replies()`
Paginated replies to a comment.

**Query:** `page`, `perPage`, `commentId`, `sortBy` — all required.
**Response:** `BaseResponse<PaginationModel<CommentModel>>` (reuses CommentModel).

---

### 25. POST `member/network/join` — `joinNetwork()`
Join the user to a network on app start. Called from MainCubit.initial().

**Body:** `Map<String, dynamic>` — callers pass `{ code: <networkCode> }`. Contract beyond that key is unclear.
**Response:** `BaseResponse<dynamic>`.
> Backend should formalize this — pin down expected keys.

---

### 26. GET `member/network/member` — `networkMembers()`
Member directory inside a network (search + paginate).

**Query:** `page` (int), `perPage` (int), `keyword` (String), `code` (String network code) — all required.
**Response (`BaseResponse<PaginationModel<NetworkMemberModel>>`):**

`NetworkMemberModel`: `memberId` (int?), `name`, `provinceId` (dynamic), `provinceName`, `cityId` (dynamic), `cityName`, `email`, `phone`, `gender`, `isEmailVerified` (int?), `isPhoneVerified` (int?), `postalCode` (dynamic), `imageUrl`, `coverUrl`, `biography`, `birthdate`, `address`, `dateRegister`.

---

### 27. GET `member/network/tag` — `networkTags()`
Tags inside a network, used by Education page.

**Query:** `page?`, `perPage?`, `keyword?`, `code` (network code, required), `sort?` (note: wire-level key is `sort`, not `sortBy`).
**Response (`BaseResponse<PaginationModel<TagModel>>`):**
`TagModel`: `tag` (String?), `count` (int?), `created` (String?).

---

### 28. GET `member/report/category` — `reportCategories()`
Static list of report reasons. No params.
**Response (`BaseResponse<List<ReportCategoryModel>>`):**
`ReportCategoryModel`: `memberReportMemberCategoryId` (int?), `category` (String?), `description` (String?).

---

### 29. POST `member/report/memberReport` — `reportMember()`
**Body:** `networkCode` (String), `memberId` (int), `reportCategoryId` (int) — all required.
**Response:** `BaseResponse<dynamic>`.

---

### 30. POST `member/post/report` — `reportPost()`
**Body:** `postId` (int), `reportCategoryId` (int) — required.
**Response:** `BaseResponse<dynamic>`.

---

## 1.4 Product — [product_remote_source.dart](lib/core/network/remote/product/product_remote_source.dart)

### 31. POST `member/product/course/share` — `courseShare()`
Generate a share link / record a share event for a course. Called from the audio player VM.

**Body (`CourseShareRequestRequest`):** `code` (String, required).
**Response:** `BaseResponse` (no data).

---

## 1.5 Notification — [notification_remote_source.dart](lib/core/network/remote/notification/notification_remote_source.dart)

### 32. GET `member/notification/list` — `notifications()`
Paginated notification list. Used by main notification page and main cubit (for unread badge).

**Query (`NotificationQueryRequest.toJson()`):** `page?`, `perPage?` (default 50 in bloc).
**Response (`BaseResponse<PaginationModel<NotificationModel>>`):**

`NotificationModel`: `notificationId` (int?), `title`, `message`, `isSeen` (int?, 0/1), `created`, `updated` (ISO 8601 strings), `refTable` (e.g. `"posts"`, `"comments"`), `refId` (int?), `type`.

---

### 33. POST `member/notification/seen` — `markSeen()`
**Body (`NotificationSeenRequest`):** `notificationId` (String, required).
**Response:** `BaseResponse<dynamic>`.

---

## 1.6 General — [general_remote_source.dart](lib/core/network/remote/general/general_remote_source.dart)

### 34. POST `member/upload/temporary` — `uploadFile()` (multipart)
Multipart upload of images used in post creation.

**Multipart field:** `image` (`List<MultipartFile>?`) — repeated field, sent as an array.
**Response (`BaseResponse<FileUploadModel>`):**
`FileUploadModel.image` is `List<Image>`. Each `Image`:
| Field | Type |
|---|---|
| `filename` | String? |
| `size` | int? |
| `fileId` | String? — used as the `images[].fileId` value when creating a post |
| `status` | bool? |
| `message` | String? |
| `url` | String? (relative) |
| `fullUrl` | String? (absolute) |
| `type` | String? (MIME) |

> Duplicates legacy `uploadTempUrl` (still consumed by `SharedService.uploadTemporary` — raw multipart).

---

## 1.7 Shared response shapes — PostModel & CommentModel

These are the two most complex models in the contract. Backend changes here have the highest blast radius.

### `PostModel`
| Field | Type | Notes |
|---|---|---|
| `postId` | int? |  |
| `postContentData` | `PostContentDataModel?` | rich-content structure |
| `postType` | String? |  |
| `title` | String? |  |
| `contentTitle` | String? |  |
| `content` | String? | plain content |
| `embed` | String? |  |
| `embedUrl` | String? |  |
| `embedData` | `PostEmbedDataModel?` | OG-data style |
| `fullContent` | String? |  |
| `excerpt` | String? |  |
| `images` | `List<String>?` |  |
| `attachments` | `List<dynamic>?` |  |
| `audios` | `List<dynamic>?` |  |
| `memberIdPost` | int? |  |
| `video` | dynamic | shape is unclear — backend should formalize |
| `videoThumbnailUrl` | String? |  |
| `statusLike` | String? |  |
| `countLike` | int? |  |
| `starred` | int? |  |
| `countComment` | int | required, default 0 |
| `timeAgo` | String? |  |
| `dateAgo` | String? |  |
| `topic` | `PostTopicModel?` |  |
| `canEdit` | bool? |  |
| `canDelete` | bool? |  |
| `pinned` | int? |  |
| `havePolling` | int? |  |
| `creator` | `PostCreatorModel?` |  |
| `isJoined` | bool? |  |
| `publishStatus` | String? |  |
| `postUrl` | String? |  |
| `postOriginalUrl` | String? |  |

**Nested shapes:**
- `PostContentDataModel`: `plain` (String?), `linkData` (List<dynamic>?), `attributeData` (`List<PostAttributeDataModel>?`), `excerptIndex` (int?), `excerpt` (String?).
- `PostAttributeDataModel`: `index` (int, default 0), `type` (String?), `data` (`PostAttributeTagModel?`), `text` (String?).
- `PostAttributeTagModel`: `tag` (String?), `memberId` (int?), `memberName` (String?).
- `PostEmbedDataModel`: `title`, `description`, `url`, `type`, `image`, `authorName`, `authorUrl`, `providerName`, `providerUrl`, `providerIcon` — all String?.
- `PostTopicModel`: `topicId` (int?), `topicName`, `topicType`, `topicIcon` — strings.
- `PostCreatorModel`: `memberId` (int?), `name`, `profileImage`, `profileCoverImage`.

### `CommentModel`
| Field | Type | Notes |
|---|---|---|
| `commentId` | int? |  |
| `replyId` | int? |  |
| `postId` | int? |  |
| `memberId` | int? |  |
| `memberName` | String? |  |
| `memberProfileImage` | String? |  |
| `embed` | String? |  |
| `embedUrl` | dynamic | unspecified shape |
| `embedData` | dynamic | unspecified shape |
| `content` | String? |  |
| `fullContent` | String? |  |
| `image` | dynamic |  |
| `audio` | dynamic |  |
| `statusLike` | String? |  |
| `timeAgo` | String? | ⚠ **fallback**: parser accepts both `timeAgo` and `time_ago` |
| `dateAgo` | String? | ⚠ **fallback**: parser accepts both `dateAgo` and `date_ago` |
| `countLike` | int? |  |
| `countLikeInKilo` | int? |  |
| `replyCount` | int? |  |
| `mentions` | `List<String>?` |  |

---

# Part 2 — Legacy `http` Endpoints

URLs declared in [api_connection.dart](lib/shared/api/api_connection.dart). All paths below are prefixed with `{baseUrl}/api`. Headers automatically include `Authorization: Bearer {token}` where applicable.

## 2.1 Auth — [auth_service.dart](lib/shared/api/services/auth_service.dart)

### 35. POST `/member/oauth/token` — `AuthService.getTokenAuth()`
Same contract as Retrofit #1, parsed into `TokenModel`:
- `token` (String) — note the legacy field is `token`, the Retrofit one is `access_token`. **Contract divergence between layers.**
- `refresh_token` (String?)
- `expired_at` (String — `yyyy-MM-dd HH:mm:ss`)
- `timeout_duration` (int — seconds)

### 36. POST `/member/auth/devices` — `AuthService.updateDevice()`
Register device for FCM after login.
**Body:** `deviceId` (String), `platform` (`ios`/`android`), `fcmToken` (String) — all required.
**Response:** returns `data.data.cloudMessagingId` (String?, **nullable** — backend has been observed returning null on some responses).
> Past failure mode (fixed in `dbc63de`, 2026-05-12): client previously called `.toString()` on a possibly-null `cloudMessagingId`, producing the literal string `"null"`, which was then stored in SharedPreferences and sent back on logout as `{"cloudMessagingId": "null"}` — suspected cause of intermittent backend logout hangs. Backend should clarify whether `cloudMessagingId` can be null and document the semantics.

### 37. POST `/member/oauth/refresh` (`refreshTokenUrl`) ⚠ **UNUSED**
Token refresh endpoint declared but never invoked anywhere.

### 38. POST `/member/auth/register` — `AuthService.register()`
**Legacy email register flow** (newer flow is Retrofit #2 by phone). Verify with PM whether this is still surfaced in any UI path — likely effectively dead.
**Body:** `name`, `email`, `password`, `phoneCode` required; `phone` optional.
**Response:** raw JSON, untyped.

### 39. GET `/member/info` (`appInfoUrl`) ⚠ **UNUSED**
Only commented-out reference at `auth_service.dart:350`. Replaced by Retrofit #5.

### 40. POST `/member/auth/cloudMessaging` — `AuthService.updateMessagingId()`
**Body:** `cloudMessagingId` (String). **Response:** generic.

### 41. POST `/member/account/logout` — `AuthService.logout()`
Same path as Retrofit #6.
**Body:** `cloudMessagingId` (String). **Response:** generic.

### 42. POST `/member/account/changePassword` — `AuthService.changePassword()`
**Body:** `oldPassword`, `newPassword`, `confirmNewPassword` — all required.
**Response:** raw JSON.

### 43. POST `/member/auth/requestForgotPassword` — `AuthService.forgotPassword()`
**Body:** `email` (String). **Response:** raw JSON.

### 44. POST `/member/auth/forgotPasswordVerification` — `AuthService.confirmForgotPassword()`
**Body:** `email`, `verifyCode`, `newPassword`, `confirmNewPassword`. **Response:** raw JSON.

### 45. POST `/member/auth/validateOtp` — `AuthService.forgotPasswordOTPVerification()`
**Body:** `email`, `verifyCode`. **Response:** null on success.
> Distinct path from Retrofit #4 (`validateOtpPhone`) — this one is for the email forgot-password flow.

### 46. GET `/member/data/commisionSummary` — `AuthService.getCommision()`
No params.
**Response (`CommisionModel`):**
- `totalSales` (double) ← `totalCommision`  *(sic — backend typo)*
- `totalTransaction` (double) ← `totalTransactionSales`

---

## 2.2 Profile — [profile_service.dart](lib/shared/api/services/profile_service.dart)

### 47. GET `/member/account/profile/info` — `ProfileService.fetchProfile()`
Same path as Retrofit #9 but different parser (legacy `ProfileModel`).

**Response (legacy `ProfileModel`):** same field set as Retrofit ProfileModel, plus these **fallback chains** flagged in [feedback memory](file:MEMORY.md) as migration scaffolding:
| Field | Fallback chain |
|---|---|
| `image` | `imageUrl` → `memberImageUrl` → `''` |
| `bio` | `bio` → `biography` |

Note: `email` is set from the method parameter, not from JSON.

### 48. POST `/member/account/profile/update` — `ProfileService.updateGeneralInformation()`
**Body:** `name`, `email`, `phoneCode` required; `phone`, `image`, `biography` optional.
**Response:** parsed as `ProfileModel`.

---

## 2.3 Location — [location_service.dart](lib/shared/api/services/location_service.dart)

All four list endpoints share a legacy pagination envelope: `meta: { total, page, lastPage }`, `data: [...]`.

### 49. GET `/member/data/location/country` — `fetchCountry()`
**Query:** `page` (default `1`), `perPage` (default `20`), `keyword?`, `countryId?`.
**Response item (`CountryModel`):** `id`, `name`.

### 50. GET `/member/data/location/province` — `fetchProvince()`
**Query:** `page`, `perPage`, `countryId` (required), `keyword?`, `provinceId?`.
**Response item (`ProvinceModel`):** `id`, `countryId`, `name`.

### 51. GET `/member/data/location/city` — `fetchCity()`
**Query:** `page`, `perPage`, `countryId`, `provinceId` (required), `keyword?`, `cityId?`.
**Response item (`CityModel`):** `id`, `countryId`, `provinceId`, `name`.

### 52. GET `/member/data/location/district` — `fetchDistrict()`
**Query:** `page`, `perPage`, `countryId`, `provinceId`, `cityId` (required), `keyword?`, `districtId?`.
**Response item (`DistrictModel`):** `id`, `countryId`, `provinceId`, `cityId`, `name`.

### 53. POST `/member/account/profile/location` — `updateLocation()`
**Body:** `countryId`, `provinceId`, `cityId`, `districtId`, `address`, `postalCode` — all required.
**Response:** parsed as `ProfileModel`.

---

## 2.4 Banner — [banner_service.dart](lib/shared/api/services/banner_service.dart)

### 54. GET `/member/data/banner` — `listBanner()`
**Query:** `page` (default `1`), `perPage` (default `3`).
**Response (`List<BannerModel>`):**
- `id` (int) ← `tribeversityBannerId`
- `client` (String)
- `link` (String) ← `linkUrl`
- `image` (List<String>) ← `images[].url`

> Parser tolerates both direct list and `{ items: [...] }` envelope — flag for cleanup.

---

## 2.5 Product — [product_service.dart](lib/shared/api/services/product_service.dart)

### 55. GET `/member/product/list` — `listProduct()`
**Query:** `page` (default `1`), `perPage` (default `100`).
**Response (`List<ProductModel>`)** — **heavy fallback-chain area**, every field below has a `??` chain:

| Field | Type | Fallback chain |
|---|---|---|
| `id` | int | `networkAccountProductAffiliatorId` ?? `productId` ?? 0 |
| `type` | String | `productType` ?? `type` ?? `''` |
| `typeLabel` | String | `productTypeLabel` ?? `typeLabel` ?? `''` |
| `code` | String | `productCode` ?? `code` ?? `id` ?? `''` |
| `slug` | String | `productSlug` ?? `slug` ?? `''` |
| `name` | String | `productName` ?? `title` ?? `''` |
| `category` | List<String> | from `productCategory[]` |
| `price` | double | `productPrice` ?? `price` ?? 0.0 |
| `thumbnail` | String | `productImageUrl` ?? `thumbnail` ?? `''` |
| `lastUpdate` | String | `lastUpdated` ?? `updatedAt` ?? `createdAt` ?? `''` |
| `productUrl` | String | `''` |
| `isPurchashed` *(sic)* | bool | `isPurchased` |
| `productPaymentUrl` | String? |  |
| `shareUrl` | String? | `productShareDetailUrl` ?? `shareUrl` |
| `commission` | double? | `commisionFixAmount` *(sic typo)* |

### 56. GET `/member/product/course/detail` — `detailProduct()`
**Query:** `code` (String, required).
**Response (`ProductDetailModel`)** — also heavy fallback area:

| Field | Type | Fallback chain |
|---|---|---|
| `id` | int | `courseId` ?? `productId` ?? `id` ?? 0 |
| `code` | String |  |
| `name` | String | `name` ?? `productName` ?? `title` ?? `''` |
| `description` | String |  |
| `descriptionHtml` | String | `descriptionHtml` ?? `description` ?? `''` |
| `imageUrl` | String | `imageUrl` ?? `productImageUrl` ?? `thumbnail` ?? `''` |
| `isPurchased` | bool | `isPurchase` ?? `isPurchased` ?? false |
| `price` | double | `price` ?? `productPrice` ?? 0.0 |
| `status` | String |  |
| `productPaymentUrl` | String? |  |
| `shareUrl` | String? | `productShareDetailUrl` |
| `dataSellingPoint` | List<dynamic> | `sellingPoint` ?? `dataSellingPoint` ?? [] |
| `dataLesson` | List<dynamic> | `lessonsData` ?? `lessons` ?? `lessonData` ?? [] |
| `dataContent` | `List<ProductDataContent>` | flattened from `lessonsData[].courseLessonData[].slidesData[]` |
| `dataRating` | Map<String, dynamic> | `ratingSummary` ?? `dataRating` ?? {} |

**`ProductDataContent`:** `id`, `type` (`AudioTemplate` \| `VideoTemplate`), `title`, `description`, `audio?` (`ProductDataAudioModel`), `video?` (`ProductDataVideoModel`).
- **`ProductDataAudioModel`:** `id`, `title`, `description`, `duration` (int seconds), `videoLibraryId` (Bunny lib), `guid` (Bunny GUID), `audioName`, `availableRes`.
- **`ProductDataVideoModel`:** `id`, `title`, `description`, `platform` (`youtube` \| `bunnycdn` \| …), `url`, `duration` (int seconds).

### 57. GET `/member/account/getPaymentToken` — `getPaymentToken()`
No params. **Response:** `data.data.token` (String).

---

## 2.6 Delete Account — [delete_account_service.dart](lib/shared/api/services/delete_account_service.dart)

### 58. POST `/member/account/requestDeleteAccount` — `requestDetele()` *(sic)*
**Body:** `email`. **Response:** null on success.

### 59. POST `/member/account/verificationDeleteAccount` — `confirmDelete()`
**Body:** `otpCode`. **Response:** null on success.

### 60. POST `/member/account/recoverAccountScheduled` — `recoverAccount()`
No body. Cancels a pending deletion within the grace period.

---

## 2.7 Shared — [shared_service.dart](lib/shared/api/services/shared_service.dart)

### 61. POST `/member/upload/temporary` — `uploadTemporary()` (raw multipart)
Same path as Retrofit #34. Different code path: builds `http.MultipartRequest` directly.
**Multipart fields:** `image[0]`, `image[1]`, … (array-indexed).
**Response:** `List<String>` of uploaded URLs from `data.data.image`.

---

## 2.8 Third-party (BunnyCDN — not your backend)

### Bunny Stream — `BunnynetService.getDetailVideo()`
`GET https://video.bunnycdn.com/library/{libraryId}/videos/{videoId}` — Header `AccessKey: {bunnynetStreamApiKey}`.
**Response (`BunnynetDetailVideoModel`):** `availRes` (List<String>, from comma-separated string), `height` (double), `width` (double), `isLandscape` (computed).

### Bunny Storage audio — `ProductService.downloadAudio()`
`GET https://storage.bunnycdn.com/vz-5439ef3e-878/{audioId}/original?accessKey={token}&download` → raw bytes.

---

# Part 3 — Contract Issues to Resolve

Specific items the backend team needs to decide on for the new contract:

### 3.1 Field-name fallbacks to canonicalize
Per [project memory](memory/project_field_fallbacks.md), these `??` chains are migration scaffolding. Backend should pick **one** name per field and the client will drop the fallback once stable:

| Model | Field | Options |
|---|---|---|
| ProfileModel (legacy) | image | `imageUrl` / `memberImageUrl` |
| ProfileModel (legacy) | bio | `bio` / `biography` |
| CommentModel (Retrofit) | timeAgo | `timeAgo` / `time_ago` |
| CommentModel (Retrofit) | dateAgo | `dateAgo` / `date_ago` |
| ProductModel | id | `networkAccountProductAffiliatorId` / `productId` |
| ProductModel | type | `productType` / `type` |
| ProductModel | typeLabel | `productTypeLabel` / `typeLabel` |
| ProductModel | code | `productCode` / `code` / `id` |
| ProductModel | slug | `productSlug` / `slug` |
| ProductModel | name | `productName` / `title` |
| ProductModel | price | `productPrice` / `price` |
| ProductModel | thumbnail | `productImageUrl` / `thumbnail` |
| ProductModel | lastUpdate | `lastUpdated` / `updatedAt` / `createdAt` |
| ProductModel | shareUrl | `productShareDetailUrl` / `shareUrl` |
| ProductDetailModel | id | `courseId` / `productId` / `id` |
| ProductDetailModel | name | `name` / `productName` / `title` |
| ProductDetailModel | descriptionHtml | `descriptionHtml` / `description` |
| ProductDetailModel | imageUrl | `imageUrl` / `productImageUrl` / `thumbnail` |
| ProductDetailModel | isPurchased | `isPurchase` / `isPurchased` |
| ProductDetailModel | price | `price` / `productPrice` |
| ProductDetailModel | dataSellingPoint | `sellingPoint` / `dataSellingPoint` |
| ProductDetailModel | dataLesson | `lessonsData` / `lessons` / `lessonData` |
| ProductDetailModel | dataRating | `ratingSummary` / `dataRating` |

### 3.2 Type drift (int↔string)
`ProfileModel` location IDs (`countryId`, `provinceId`, `cityId`, `districtId`, `postalCode`, `phoneNumber`, `phoneCode`) currently use a custom `_stringFromDynamic` converter because the backend returns either type. Pick one — **prefer string** for IDs (avoids JSON-number precision issues, future-proof for non-numeric IDs).

`PaginationModel`'s `total` / `lastPage` / `perPage` / `currentPage` / `timestamp` are typed as `dynamic` for the same reason. Standardize to `int` (or `long` for timestamp if epoch-millis).

`InfoModel.maintenance` and `InfoCommunityModel.networkId` (endpoint #5) — coerced from string→int by `InfoModel.fromJson`. Standardize to `int`.

`AuthService.updateDevice()` response `cloudMessagingId` (endpoint #36) — observed as either string or null. Decide intended semantics; if absence is meaningful, document it.

### 3.3 Shape drift
- `ProfileModel.affiliateConnectedData` — backend sometimes returns `[]`, sometimes an object. Pick one: `null` when empty, object when present.
- `PostModel.video` — typed `dynamic`. Backend should formalize.
- `CommentModel.embedUrl` / `embedData` / `image` / `audio` — all `dynamic`. Formalize.
- `BannerService` parser accepts both bare list and `{ items: [] }` — pick the paginated envelope.

### 3.4 Endpoint duplication
Both layers hit the same path; remove from the legacy layer once VMs migrate:
| Path | Retrofit | Legacy |
|---|---|---|
| GET `/member/info` | #5 (used) | #39 (unused, can drop) |
| POST `/member/account/logout` | #6 | #41 |
| GET `/member/account/profile/info` | #9 | #47 |
| POST `/member/upload/temporary` | #34 | #61 |

### 3.5 Contracts to formalize / decide
- POST `/member/network/join` (#25) — caller only passes `{ code }`. Formalize the full body.
- POST `/member/oauth/token` (#1 / #35) — legacy parses `token` + `expired_at` + `timeout_duration`; Retrofit parses `access_token` + `expires_in`. Pick one wire shape; the new backend should be consistent.
- POST `/member/oauth/refresh` (#37) — declared, never used. Decide if token refresh will be supported (recommended, otherwise short-lived tokens cause silent logouts).
- POST `/member/post/create` (#15 vs #16) — same path used for create AND update, differentiated by `postId` presence. Consider splitting in the new contract.
- Naming typos worth fixing while breaking the contract: `totalCommision`, `commisionFixAmount`, `isPurchashed` (Dart-side), `requestDetele` (Dart-side).

### 3.6 Endpoints to drop
The 6 unused endpoints from the audit (Part 1+2 — `updatePost`, `deletePost`, `updateComment`, `deleteComment`, `oauth/refresh`, legacy `appInfoUrl`). Confirm with PM before backend drops the four community CRUD methods — the scaffolding looks deliberate.

---

# Verification

This document was assembled by:
1. Reading every Retrofit interface file in `lib/core/network/remote/`.
2. Reading every request model under `lib/core/model/request/`.
3. Reading every response model under `lib/core/model/response/`.
4. Reading every service in `lib/shared/api/services/` and the URL constants in `lib/shared/api/api_connection.dart`.
5. Cross-referencing actual caller code (BLoCs, Cubits, VMs) to resolve `Map<String, dynamic>` query/body keys that aren't visible from the API signature.
6. Resolving 7 false-positive "dead method" flags by grepping for every `XxxUseCase` and component-level call.

No code changes are proposed in this document. The next step depends on your direction — possible follow-ups include: handing this to the backend team for new-contract design, marking the 6 unused endpoints for removal, or drafting the migration plan to consolidate the two API layers.