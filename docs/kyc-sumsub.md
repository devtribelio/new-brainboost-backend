# KYC via Sumsub (affiliate disbursement gate)

Status: code complete, **pending sandbox creds + mobile SDK integration + QA**.
Mobile FE integration guide: `docs/kyc-sumsub-mobile.md`.

## Context

**Correction (2026-06-24):** legacy KYC **is** real and is now migrated — an earlier
version of this doc wrongly said "no real KYC, nothing to port." The truth:
`members.verification_kyc` / `last_kyc_status` are denormalised **caches** surfaced in the
member payload (`TBMember.php:343,510`) — the tribelio *app* has no writer, but the
authoritative data lives in the **`member_data_kyc`** table (full KTP / NIK / selfie /
bank / business submissions; ~5.7k distinct members; APPROVED ≈2.8k, REJECTED ≈4.5k,
PENDING 12 across all rows). It is **actively** maintained by `tribelio-admin/` (a separate
legacy app, out of jcodemunch index — hence the missing writer; reviews carry
`actionby`/`actionat`). `member.last_kyc_status` lags `member_data_kyc`, so the table (latest
row per member) is the source of truth. Legacy KYC is carried over by
`scripts/migrate-kyc.ts` (see below); the Sumsub provider only replaces the *new* review flow.

### Legacy KYC migration (`migrate:kyc`)

- Run after `migrate:members`. Source = latest `member_data_kyc` row per member.
- Carries **APPROVED + REJECTED** only → `kycStatus`, `kycSource='LEGACY'`,
  `kycIdNumber=nik`, `kycReviewedAt=actionat`, `kycRejectedReason=reason`. PENDING (and any
  other value) is skipped so those members re-KYC fresh via Sumsub.
- Redirect-aware (a dedup loser's KYC applies to its winner) and idempotent; guarded with
  `kycSource IN ('NONE','LEGACY')` so a re-run never clobbers a new MANUAL/SUMSUB decision.
- Legacy KTP/selfie **images are not migrated** (they live in legacy S3); a legacy-APPROVED
  member therefore has `sumsubApplicantId = null` and no `kycIdCardUrl`/`kycSelfieUrl`.
- New `members.kyc_source` column records provenance of the current `kycStatus`:
  `NONE | LEGACY | MANUAL | SUMSUB`. Trial DB result: ≈2.4k members (APPROVED ≈1.5k,
  REJECTED ≈0.86k).

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
