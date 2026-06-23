# KYC via Sumsub (affiliate disbursement gate)

Status: code complete, **pending sandbox creds + mobile SDK integration + QA**.
Mobile FE integration guide: `docs/kyc-sumsub-mobile.md`.

## Context

Legacy had no real KYC: `members.verification_kyc` / `last_kyc_status` were read-only
flags surfaced in the member payload (`TBMember.php:343,510`) with **no writer anywhere
in the repo**; `TBModule::memberDataKyc()` referenced a module class that does not exist.
Nothing to port.

The new backend already had a **manual KYC** flow (KTP number + ID-card/selfie upload →
`kycStatus PENDING` → admin review) gating affiliate disbursement. Sumsub replaces the
human review; the gate itself is unchanged: `requestDisbursement` still requires
`kycStatus === 'APPROVED'`.

## Flow

```
mobile                    backend                              Sumsub
  |  POST /affiliate/me/kyc/token  |                              |
  |------------------------------>|  create applicant (once,     |
  |                               |  externalUserId = member.id) |
  |                               |----------------------------->|
  |                               |  POST /resources/accessTokens/sdk
  |                               |----------------------------->|
  |   { token, applicantId }      |                              |
  |<------------------------------|                              |
  |  run Sumsub MobileSDK(token) — capture KTP + selfie ───────-->|
  |                               |   webhook applicantPending   |
  |                               |<-----------------------------|  → kycStatus PENDING
  |                               |   webhook applicantReviewed  |
  |                               |<-----------------------------|  → GREEN  = APPROVED
  |                               |                              |  → RED    = REJECTED
```

- `POST /api/member/affiliate/me/kyc/token` (auth) → `DisbursementService.createSumsubKycSession`.
  Creates the applicant on first call (409 = already exists → resolved via
  `getApplicantByExternalId`), stores `members.sumsub_applicant_id`, mints a short-lived
  SDK access token (`SUMSUB_TOKEN_TTL_SECONDS`, default 600). Refused when already APPROVED.
- `POST /api/webhook/sumsub` — guard `sumsubDigestGuard`: HMAC over the **raw body**
  (captured by the `express.json` `verify` hook in `app.ts`) vs `x-payload-digest`,
  algorithm from `x-payload-digest-alg` (`HMAC_SHA256_HEX` default, SHA1/SHA512 supported).
  Fails closed when `SUMSUB_WEBHOOK_SECRET` unset.
- Handled events (`sumsub.handler.ts`): `applicantPending` → PENDING (mirrors manual
  submit), `applicantReviewed` GREEN → APPROVED / RED → REJECTED with
  `kycRejectedReason = "<rejectType>: <labels>"`. All other event types are acked 200 and
  ignored. Member resolved by `sumsubApplicantId`, falling back to `externalUserId`
  (our member UUID). Writes are absolute → webhook replays are idempotent.
- RED `FINAL` vs `RETRY`: both store REJECTED. Re-submission limits are enforced by
  Sumsub itself on the same applicant (FINAL → SDK refuses further attempts). The token
  endpoint intentionally still issues tokens for REJECTED members.

## Manual flow status

`POST /affiliate/me/kyc` (manual submit) is **kept** as fallback; admin override columns
(`kycReviewedBy` etc.) remain. Note: a replayed Sumsub webhook can overwrite a manual
admin decision for a member that has a Sumsub applicant — acceptable, Sumsub is the
source of truth once a member enters that flow.

## Credentials (per environment — sandbox and prod are separate pairs)

| Env var | Source |
|---|---|
| `SUMSUB_APP_TOKEN` / `SUMSUB_SECRET_KEY` | Dashboard → Dev space → App tokens (secret shown once) |
| `SUMSUB_WEBHOOK_SECRET` | Dashboard → Webhooks → endpoint secret (≠ API secret) |
| `SUMSUB_LEVEL_NAME` | Level created in dashboard (default `basic-kyc-idn`) |
| `SUMSUB_BASE_URL` | `https://api.sumsub.com` (same for sandbox/prod) |
| `SUMSUB_TOKEN_TTL_SECONDS` | optional, default 600 |

Empty creds = feature off: token endpoint returns 400 "KYC provider not configured",
webhook guard 401s everything.

## Files

- `packages/common/src/services/sumsub.client.ts` — signed REST client
- `packages/common/src/services/sumsub-signature.ts` — request sig + webhook digest verify
- `packages/domain/src/affiliate/disbursement.service.ts` — `createSumsubKycSession`,
  `markSumsubPending`, `applySumsubReview`
- `apps/mobile-api/src/modules/webhook/{sumsub.handler,sumsub-digest.guard}.ts`
- `prisma/migrations/20260612090000_member_sumsub_applicant_id/`
- Tests: `apps/mobile-api/tests/sumsub-signature.spec.ts`,
  `apps/mobile-api/tests/affiliate/kyc-sumsub.spec.ts`

## Outstanding

- [ ] Sumsub account + sandbox creds + level setup (blocker for QA)
- [ ] Register prod webhook URL in dashboard
- [ ] Mobile app: integrate MobileSDK against `/affiliate/me/kyc/token`
- [ ] Add `SUMSUB_*` block to `.env.example` (file edit was permission-blocked this session)
- [ ] Decide whether to retire the manual `POST /affiliate/me/kyc` once Sumsub is live
