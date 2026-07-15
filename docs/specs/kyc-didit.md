# KYC via Didit (affiliate disbursement gate)

Status: code complete, **pending Didit Console setup (workflow + creds) + mobile SDK
integration + QA**. Mobile FE integration guide: `docs/specs/kyc-didit-mobile.md`.

> Provider history: the new review flow was first built on **Sumsub**, then switched to
> **Didit** (cost — Didit's KYC is effectively free for the ID + liveness + face-match
> workflow we use; confirm the workflow stays on the free tier in the Console). The data
> model, the disbursement gate, the re-KYC rules, and the manual fallback are unchanged —
> only the provider adapter (client + webhook + env) was swapped. See `docs/specs/kyc-rekyc.md`.

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
`scripts/migrate-kyc.ts` (see below); the Didit provider only replaces the *new* review flow.

### Legacy KYC migration (`migrate:kyc`)

- Run after `migrate:members`. Source = latest `member_data_kyc` row per member.
- Carries **APPROVED + REJECTED** only → `kycStatus`, `kycSource='LEGACY'`,
  `kycIdNumber=nik`, `kycReviewedAt=actionat`, `kycRejectedReason=reason`. PENDING (and any
  other value) is skipped so those members re-KYC fresh via Didit.
- Redirect-aware (a dedup loser's KYC applies to its winner) and idempotent; guarded with
  `kycSource IN ('NONE','LEGACY')` so a re-run never clobbers a new MANUAL/DIDIT decision.
- Legacy KTP/selfie **images are not migrated** (they live in legacy S3); a legacy-APPROVED
  member therefore has `kycProviderRef = null` and no `kycIdCardUrl`/`kycSelfieUrl`.
- New `members.kyc_source` column records provenance of the current `kycStatus`:
  `NONE | LEGACY | MANUAL | DIDIT`.

The new backend already had a **manual KYC** flow (KTP number + ID-card/selfie upload →
`kycStatus PENDING` → admin review) gating affiliate disbursement. Didit replaces the
human review; the gate itself is unchanged: `requestDisbursement` still requires
`kycStatus === 'APPROVED'`.

## Flow

```
mobile                    backend                              Didit
  |  POST /affiliate/me/kyc/token  |                              |
  |------------------------------>|  POST /v3/session/           |
  |                               |  {workflow_id,               |
  |                               |   vendor_data = member.id}   |
  |                               |----------------------------->|
  |                               |  { session_id, session_token, url }
  |                               |  store session_id →          |
  |                               |   members.kyc_provider_ref   |
  | { sessionId, sessionToken, url, kycStatus }                  |
  |<------------------------------|                              |
  |  DiditSdk.startVerification(sessionToken) — KTP + selfie ───->|
  |   (or open `url` in a webview fallback)                       |
  |                               |  webhook status "In Review"  |
  |                               |<-----------------------------|  → kycStatus PENDING
  |                               |  webhook status "Approved"   |
  |                               |<-----------------------------|  → APPROVED
  |                               |              "Declined"      |  → REJECTED
```

- `POST /api/member/affiliate/me/kyc/token` (auth) → `DisbursementService.createDiditSession`.
  Didit is **session-per-attempt**: every call mints a fresh `/v3/session/` (no persistent
  applicant) and stores its `session_id` as the member's **active** `kyc_provider_ref`.
  Returns `{ sessionId, sessionToken, url, kycStatus }` — mobile launches the native SDK
  with `sessionToken` (or opens `url` in a webview). Refused when already APPROVED, or when
  the **min-balance gate** fails (see below).
- **Min-balance gate (`assertBalanceForKyc`):** a member may only REQUEST KYC once their
  **withdrawable balance** (`getWithdrawableBalance` = cleared BALANCE commissions − HELD
  payouts) reaches `app_settings.kyc.minBalance`. Applied to **both** `createDiditSession`
  and the manual `submitKyc` (no bypass). Threshold is runtime-configurable via the
  `SettingsService` cache (≤30s propagation); `0` disables the gate (fallback default
  `KYC_MIN_BALANCE_DEFAULT = 0`). Seeded value: **55 000 IDR** (`pnpm seed:settings`).
  Applied uniformly to every not-yet-APPROVED state (NONE/PENDING/REJECTED/EXPIRED). On
  failure: `400 'Saldo belum mencukupi untuk verifikasi KYC'`. Rationale: don't spend
  verification/review effort on nil-balance accounts.
  - `GET /affiliate/me/kyc` (`getKyc`) surfaces the gate so the FE can pre-empt the 400:
    `kycMinBalance` (the threshold) + `isEligible` (`kycStatus !== 'APPROVED' &&
    withdrawableBalance >= kycMinBalance`).
- `POST /api/webhook/didit` — guard `diditSignatureGuard`: HMAC-SHA256 over the **raw body**
  (captured by the `express.json` `verify` hook in `app.ts`) vs the `X-Signature` header,
  plus an `X-Timestamp` replay guard (`abs(now - ts) <= 300s`). Fails closed when
  `DIDIT_WEBHOOK_SECRET` is unset.
- Handled statuses (`didit.handler.ts`): `In Review` / `In Progress` / `Resubmitted` →
  PENDING (mirrors manual submit), `Approved` → APPROVED, `Declined` → REJECTED with
  `kycRejectedReason` from `decision`. All other statuses (`Not Started`, `Abandoned`,
  `Awaiting User`, `Expired`, …) are acked 200 and ignored.
- **Session-id guard (re-KYC safety net):** the member is resolved by `session_id`
  (fallback `vendor_data` = member UUID), and a transition is only applied when the
  webhook's `session_id` matches the member's current `kyc_provider_ref`. A stale
  "Approved" from a superseded session is ignored → it cannot silently re-approve an
  EXPIRED member. This **replaces Sumsub's `resetApplicant`** call. Writes are absolute →
  webhook replays for the active session are idempotent.

## Manual flow status

`POST /affiliate/me/kyc` (manual submit) is **kept** as fallback; admin override columns
(`kycReviewedBy` etc.) remain. A Didit webhook for the active session can overwrite a manual
admin decision — acceptable, the provider is the source of truth once a member enters that
flow.

## Credentials (Didit Console)

| Env var | Source |
|---|---|
| `DIDIT_API_KEY` | Console → Settings → API Keys (sent as `x-api-key`; auth errors are 403) |
| `DIDIT_WEBHOOK_SECRET` | Console → Webhooks → destination `secret_shared_key` (≠ API key) |
| `DIDIT_WORKFLOW_ID` | Console → Workflows (published workflow UUID; defines ID + liveness + face match) |
| `DIDIT_BASE_URL` | `https://verification.didit.me` |
| `DIDIT_CALLBACK_URL` | optional — hosted-webview deep link (e.g. `brainboost://kyc/done`); unused on the SDK path |

Empty creds (`DIDIT_API_KEY` / `DIDIT_WORKFLOW_ID`) = feature off: token endpoint returns
400 "KYC provider not configured", webhook guard 401s everything.

## Files

- `packages/common/src/services/didit.client.ts` — `x-api-key` REST client (`createSession`, `getSessionDecision`)
- `packages/common/src/services/didit-signature.ts` — webhook HMAC + timestamp verify
- `packages/domain/src/affiliate/disbursement.service.ts` — `createDiditSession`,
  `markDiditPending`, `applyDiditReview`, `findMemberForDidit`
- `apps/mobile-api/src/modules/webhook/{didit.handler,didit-signature.guard}.ts`
- `prisma/migrations/20260626120000_rename_kyc_provider_ref/` (`sumsub_applicant_id` → `kyc_provider_ref`)
- Tests: `apps/mobile-api/tests/didit-signature.spec.ts`,
  `apps/mobile-api/tests/affiliate/kyc-didit.spec.ts`

## Outstanding

- [ ] Didit account + workflow (ID + liveness + face match) + creds (blocker for QA)
- [ ] **Confirm the workflow is on the free tier** (the reason for choosing Didit) — the
      ID-verification product is advertised at $0.15/check; verify the chosen feature set is free
- [ ] Register the prod webhook destination in the Console (capture `secret_shared_key`)
- [ ] Mobile app: integrate `didit_sdk` (Flutter) / native SDK against `/affiliate/me/kyc/token`
- [ ] Replace the `SUMSUB_*` block with `DIDIT_*` in `.env.example` (file edit was permission-blocked this session)
- [ ] Decide whether to retire the manual `POST /affiliate/me/kyc` once Didit is live
