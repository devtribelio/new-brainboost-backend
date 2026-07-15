# 04 — API Reference (generated)

[⬅ Kembali ke index](README.md)

> **File ini di-generate — jangan diedit manual.** Regenerate dengan `pnpm docs:api`
> setelah menambah/mengubah route. Sumber: parse statis `apps/mobile-api/src/modules/*/`
> (`*.module.ts` + `*.routes.ts`) oleh `scripts/gen-api-docs.ts`.

Total: **102 endpoint** dari **24 modul**. Semua path di bawah sudah termasuk mount root `/api` + prefix modul. Detail request/response tiap endpoint: Swagger UI `/api/docs`.

## account

Prefix: `/api/member` · Sumber: `apps/mobile-api/src/modules/account/account.routes.ts`

| Method | Path | Handler | Auth | Middleware lain |
|---|---|---|---|---|
| POST | `/api/member/account/preRegistration` | `preRegistration` | Publik | validateDto(PreRegistrationDto) |
| POST | `/api/member/account/affiliateConnect` | `affiliateConnect` | JWT | — |
| POST | `/api/member/account/logout` | `logout` | JWT (lenient) | validateDto(LogoutDto) |
| POST | `/api/member/account/changePassword` | `changePassword` | JWT | validateDto(ChangePasswordDto) |
| GET | `/api/member/account/getPaymentToken` | `getPaymentToken` | JWT | — |
| POST | `/api/member/account/requestDeleteAccount` | `requestDeleteAccount` | JWT | validateDto(RequestDeleteAccountDto) |
| POST | `/api/member/account/verificationDeleteAccount` | `verificationDeleteAccount` | JWT | validateDto(VerificationDeleteAccountDto) |
| POST | `/api/member/account/recoverAccountScheduled` | `recoverAccountScheduled` | JWT | — |

## affiliate

Prefix: `/api/member` · Sumber: `apps/mobile-api/src/modules/affiliate/affiliate.routes.ts`

| Method | Path | Handler | Auth | Middleware lain |
|---|---|---|---|---|
| GET | `/api/member/affiliate/me` | `getMe` | JWT | — |
| POST | `/api/member/affiliate/me/mode` | `setMode` | JWT | — |
| GET | `/api/member/affiliate/me/summary` | `getSummary` | JWT | — |
| GET | `/api/member/affiliate/me/commissions` | `listMyCommissions` | JWT | — |
| GET | `/api/member/affiliate/programs` | `listPrograms` | Publik | — |
| POST | `/api/member/affiliate/programs/:code/enroll` | `enroll` | JWT | — |
| POST | `/api/member/affiliate/visits` | `logVisit` | JWT opsional | — |
| POST | `/api/member/affiliate/attribution` | `logAttribution` | JWT | — |
| GET | `/api/member/affiliate/me/bank-account` | `getBankAccount` | JWT | — |
| PUT | `/api/member/affiliate/me/bank-account` | `setBankAccount` | JWT | validateDto(SetBankAccountDto) |
| GET | `/api/member/affiliate/me/kyc` | `getKyc` | JWT | — |
| POST | `/api/member/affiliate/me/kyc` | `submitKyc` | JWT | validateDto(SubmitKycDto) |
| POST | `/api/member/affiliate/me/kyc/token` | `createKycToken` | JWT | — |
| GET | `/api/member/affiliate/me/disbursement` | `getDisbursementSummary` | JWT | — |
| POST | `/api/member/affiliate/me/disbursement` | `requestDisbursement` | JWT | validateDto(RequestDisbursementDto) |
| GET | `/api/member/affiliate/me/disbursements` | `listDisbursements` | JWT | — |

## auth

Prefix: `/api/member` · Sumber: `apps/mobile-api/src/modules/auth/auth.routes.ts`

| Method | Path | Handler | Auth | Middleware lain |
|---|---|---|---|---|
| POST | `/api/member/oauth/token` | `login` | Publik | loginRateLimiter (30 req/15 mnt per IP), validateDto(LoginDto) |
| POST | `/api/member/auth/register` | `register` | Publik | registerRateLimiter (15 req/15 mnt per IP), validateDto(RegisterDto) |
| POST | `/api/member/auth/devices` | `registerDevice` | JWT | validateDto(RegisterDeviceDto) |
| POST | `/api/member/auth/cloudMessaging` | `cloudMessaging` | JWT | validateDto(CloudMessagingDto) |
| POST | `/api/member/auth/requestForgotPassword` | `requestForgotPassword` | Publik | forgotPasswordRequestRateLimiter (10 req/15 mnt per IP), validateDto(RequestForgotPasswordDto) |
| POST | `/api/member/auth/forgotPasswordVerification` | `forgotPasswordVerification` | Publik | forgotPasswordVerifyRateLimiter (3 req/15 mnt per IP), validateDto(ForgotPasswordVerificationDto) |
| POST | `/api/member/auth/validateOtp` | `validateOtp` | Publik | validateOtpRateLimiter (3 req/15 mnt per IP), validateDto(ValidateOtpDto) |
| POST | `/api/member/auth/registerByPhone` | `registerByPhone` | Publik | registerByPhoneRateLimiter (15 req/15 mnt per IP), validateDto(RegisterByPhoneDto) |
| POST | `/api/member/auth/requestVerificationPhone` | `requestVerificationPhone` | Publik | requestVerificationPhoneRateLimiter (10 req/15 mnt per IP), validateDto(RequestVerificationPhoneDto) |
| POST | `/api/member/auth/validateOtpPhone` | `validateOtpPhone` | Publik | validateOtpPhoneRateLimiter (3 req/15 mnt per IP), validateDto(ValidateOtpPhoneDto) |
| POST | `/api/member/auth/requestVerificationEmail` | `requestVerificationEmail` | Publik | requestVerificationEmailRateLimiter (10 req/15 mnt per IP), validateDto(RequestVerificationEmailDto) |
| POST | `/api/member/auth/validateOtpEmail` | `validateOtpEmail` | Publik | validateOtpEmailRateLimiter (3 req/15 mnt per IP), validateDto(ValidateOtpEmailDto) |
| POST | `/api/member/auth/requestVerify` | `requestVerify` | JWT | validateDto(RequestVerifyDto) |
| POST | `/api/member/auth/verify` | `verify` | JWT | validateDto(VerifyDto) |

## banner

Prefix: `/api/member` · Sumber: `apps/mobile-api/src/modules/banner/banner.routes.ts`

| Method | Path | Handler | Auth | Middleware lain |
|---|---|---|---|---|
| GET | `/api/member/data/banner` | `list` | Publik | — |

## comment

Prefix: `/api/member` · Sumber: `apps/mobile-api/src/modules/comment/comment.routes.ts`

| Method | Path | Handler | Auth | Middleware lain |
|---|---|---|---|---|
| GET | `/api/member/comment/list` | `list` | JWT opsional | — |
| GET | `/api/member/comment/detail` | `detail` | JWT opsional | — |
| POST | `/api/member/comment/like` | `like` | JWT | — |
| POST | `/api/member/comment/create` | `create` | JWT | — |
| POST | `/api/member/comment/update` | `update` | JWT | — |
| POST | `/api/member/comment/delete` | `remove` | JWT | — |

## commerce

Prefix: `/api/member` · Sumber: `apps/mobile-api/src/modules/commerce/commerce.routes.ts`

| Method | Path | Handler | Auth | Middleware lain |
|---|---|---|---|---|
| POST | `/api/member/product/checkout/submit` | `startCheckout` | JWT | validateDto(StartCheckoutDto) |
| POST | `/api/member/payment/commerce` | `createPayment` | JWT | validateDto(PayDto) |
| GET | `/api/member/payment/commerce/list` | `listTransactions` | JWT | validateDto(ListTransactionsQueryDto, 'query') |
| POST | `/api/member/payment/commerce/cancel` | `cancelTransaction` | JWT | validateDto(CancelTransactionDto) |
| POST | `/api/member/payment/voucher/validate` | `validateVoucher` | JWT | voucherValidateRateLimiter (20 req/15 mnt per member (fallback IP)), validateDto(ValidateVoucherDto) |
| GET | `/api/member/payment/commerce/:transactionId` | `getTransactionStatus` | JWT | — |

## commission

Prefix: `/api/member` · Sumber: `apps/mobile-api/src/modules/commission/commission.routes.ts`

| Method | Path | Handler | Auth | Middleware lain |
|---|---|---|---|---|
| GET | `/api/member/data/commisionSummary` | `summary` | JWT | — |

## ingest

Prefix: `/api/ingest` · Sumber: `apps/mobile-api/src/modules/ingest/ingest.routes.ts`

| Method | Path | Handler | Auth | Middleware lain |
|---|---|---|---|---|
| POST | `/api/ingest/purchase` | `ingestPurchase` | API key | credentialGuard |

## location

Prefix: `/api/member` · Sumber: `apps/mobile-api/src/modules/location/location.routes.ts`

| Method | Path | Handler | Auth | Middleware lain |
|---|---|---|---|---|
| GET | `/api/member/data/location/country` | `listCountries` | Publik | — |
| GET | `/api/member/data/location/province` | `listProvinces` | Publik | — |
| GET | `/api/member/data/location/city` | `listCities` | Publik | — |
| GET | `/api/member/data/location/district` | `listDistricts` | Publik | — |

## media

Prefix: `/api/member` · Sumber: `apps/mobile-api/src/modules/media/media.routes.ts`

| Method | Path | Handler | Auth | Middleware lain |
|---|---|---|---|---|
| GET | `/api/member/media/stream` | `stream` | JWT opsional | — |
| GET | `/api/member/media/download` | `download` | JWT opsional | mediaDownloadRateLimiter (10 req/1 mnt per member (fallback IP)) |

## member

Prefix: `/api/member` · Sumber: `apps/mobile-api/src/modules/member/member.routes.ts`

| Method | Path | Handler | Auth | Middleware lain |
|---|---|---|---|---|
| GET | `/api/member/info` | `info` | JWT opsional | — |

## network

Prefix: `/api/member` · Sumber: `apps/mobile-api/src/modules/network/network.routes.ts`

| Method | Path | Handler | Auth | Middleware lain |
|---|---|---|---|---|
| POST | `/api/member/network/join` | `join` | JWT | — |
| POST | `/api/member/network/request/approve` | `approveRequest` | JWT | — |
| POST | `/api/member/network/request/reject` | `rejectRequest` | JWT | — |
| GET | `/api/member/network/member` | `members` | JWT | — |
| GET | `/api/member/network/tag` | `tags` | JWT | — |

## notification

Prefix: `/api/member` · Sumber: `apps/mobile-api/src/modules/notification/notification.routes.ts`

| Method | Path | Handler | Auth | Middleware lain |
|---|---|---|---|---|
| GET | `/api/member/notification/list` | `list` | JWT | — |
| POST | `/api/member/notification/seen` | `seen` | JWT | — |
| POST | `/api/member/notification/mute` | `mute` | JWT | — |
| POST | `/api/member/notification/unmute` | `unmute` | JWT | — |

## post

Prefix: `/api/member` · Sumber: `apps/mobile-api/src/modules/post/post.routes.ts`

| Method | Path | Handler | Auth | Middleware lain |
|---|---|---|---|---|
| GET | `/api/member/post/list` | `list` | JWT | — |
| GET | `/api/member/post/detail` | `detail` | JWT | — |
| POST | `/api/member/post/like` | `like` | JWT | — |
| POST | `/api/member/post/create` | `upsert` | JWT | — |
| POST | `/api/member/post/delete` | `remove` | JWT | — |
| POST | `/api/member/post/report` | `report` | JWT | — |

## product

Prefix: `/api/member` · Sumber: `apps/mobile-api/src/modules/product/product.routes.ts`

| Method | Path | Handler | Auth | Middleware lain |
|---|---|---|---|---|
| GET | `/api/member/product/list` | `list` | JWT | validateDto(ListProductsQueryDto, 'query') |
| GET | `/api/member/product/course/detail` | `courseDetail` | JWT | — |
| GET | `/api/member/product/list/public` | `list` | JWT opsional | validateDto(ListProductsQueryDto, 'query') |
| GET | `/api/member/product/course/detail/public` | `courseDetail` | JWT opsional | — |
| POST | `/api/member/product/course/share` | `shareCourse` | JWT | — |

## profile

Prefix: `/api/member` · Sumber: `apps/mobile-api/src/modules/profile/profile.routes.ts`

| Method | Path | Handler | Auth | Middleware lain |
|---|---|---|---|---|
| GET | `/api/member/account/profile/info` | `getInfo` | JWT | — |
| POST | `/api/member/account/profile/update` | `update` | JWT | — |
| POST | `/api/member/account/profile/location` | `updateLocation` | JWT | — |

## reply

Prefix: `/api/member` · Sumber: `apps/mobile-api/src/modules/reply/reply.routes.ts`

| Method | Path | Handler | Auth | Middleware lain |
|---|---|---|---|---|
| GET | `/api/member/reply/list` | `list` | JWT opsional | — |

## report

Prefix: `/api/member` · Sumber: `apps/mobile-api/src/modules/report/report.routes.ts`

| Method | Path | Handler | Auth | Middleware lain |
|---|---|---|---|---|
| GET | `/api/member/report/category` | `categories` | Publik | — |
| POST | `/api/member/report/memberReport` | `memberReport` | JWT | — |

## stats

Prefix: `/api/user` · Sumber: `apps/mobile-api/src/modules/tracker/stats.routes.ts`

| Method | Path | Handler | Auth | Middleware lain |
|---|---|---|---|---|
| GET | `/api/user/stats/home` | `home` | JWT | — |

## subscription

Prefix: `/api/subscription` · Sumber: `apps/mobile-api/src/modules/subscription/subscription.routes.ts`

| Method | Path | Handler | Auth | Middleware lain |
|---|---|---|---|---|
| GET | `/api/subscription/plans` | `plans` | Publik | — |
| GET | `/api/subscription/me` | `me` | JWT | — |
| POST | `/api/subscription/seats/invite` | `invite` | JWT | — |
| POST | `/api/subscription/seats/claim` | `claim` | JWT | validateDto(ClaimSeatDto) |
| DELETE | `/api/subscription/seats/:seatId` | `removeSeat` | JWT | — |
| POST | `/api/subscription/seats/leave` | `leaveSeat` | JWT | — |
| POST | `/api/subscription/cancel` | `cancel` | JWT | — |

## topic

Prefix: `/api/member` · Sumber: `apps/mobile-api/src/modules/topic/topic.routes.ts`

| Method | Path | Handler | Auth | Middleware lain |
|---|---|---|---|---|
| GET | `/api/member/topic/list` | `list` | JWT opsional | — |
| POST | `/api/member/topic/subscribe` | `subscribe` | JWT | — |

## tracking

Prefix: `/api/tracking` · Sumber: `apps/mobile-api/src/modules/tracker/tracking.routes.ts`

| Method | Path | Handler | Auth | Middleware lain |
|---|---|---|---|---|
| POST | `/api/tracking/session` | `session` | JWT | validateDto(TrackSessionDto) |

## upload

Prefix: `/api/member` · Sumber: `apps/mobile-api/src/modules/upload/upload.routes.ts`

| Method | Path | Handler | Auth | Middleware lain |
|---|---|---|---|---|
| POST | `/api/member/upload/temporary` | `temporary` | JWT | validateDto(UploadQueryDto, 'query'), upload.array('image', MAX_UPLOAD_FILES) |

## webhook

Prefix: `/api/webhook` · Sumber: `apps/mobile-api/src/modules/webhook/webhook.routes.ts`

| Method | Path | Handler | Auth | Middleware lain |
|---|---|---|---|---|
| POST | `/api/webhook/xendit/invoice` | `xenditInvoice` | Webhook guard | xenditCallbackGuard, validateDto(XenditInvoiceCallbackDto) |
| POST | `/api/webhook/revenuecat` | `revenuecatWebhook` | Webhook guard | revenueCatCallbackGuard, validateDto(RevenueCatCallbackDto) |
| POST | `/api/webhook/xendit/disbursement` | `xenditDisbursementCallback` | Webhook guard | xenditCallbackGuard, validateDto(XenditDisbursementCallbackDto) |
| POST | `/api/webhook/didit` | `diditWebhook` | Webhook guard | diditSignatureGuard |
