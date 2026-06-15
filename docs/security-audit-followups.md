# Security Audit — Remediation & Follow-ups

Source: multi-agent security + clean-code audit (11 confirmed security findings, 28
quality findings) run against the backend monorepo on 2026-06-15.

Verification of the fixes below: full `pnpm test` suite green (370 passed) against a
**clean, freshly-`db push`'d local Postgres**, plus `tsc -b` typecheck clean. The
shared `localhost:5433` datasource is an SSH tunnel to **staging** — do NOT point the
(destructive) integration suite at it. Use a local throwaway DB:

```bash
createdb bb_sec_audit
DATABASE_URL="postgresql://<user>@localhost:5432/bb_sec_audit?schema=public" pnpm prisma db push --skip-generate
DATABASE_URL="postgresql://<user>@localhost:5432/bb_sec_audit?schema=public" pnpm test
```
(`prisma migrate deploy` from scratch currently fails on the
`20260525075123_add_is_curated_to_post_and_comment` migration — it drops a constraint
that doesn't exist on a fresh DB. Use `db push` until the migration history is repaired —
**tracked below**.)

---

## ✅ Fixed in this pass

| Sev | Finding | Fix | Files |
|---|---|---|---|
| CRITICAL | Unauthenticated `/network/member` leaked all members' PII | Added `authGuard` to `/network/member` + `/network/tag` (restores legacy parity — legacy gated behind auth) | `apps/mobile-api/src/modules/network/network.routes.ts` |
| CRITICAL | Admin RBAC defined but never enforced → any ADMIN self-escalates to SUPERADMIN | `requireRole` wired into the resource loop; `admins` resource gated `requiredRole: 'SUPERADMIN'` | `apps/admin-ejs/.../admin.routes.ts`, `.../util/crud-factory.ts`, `.../resources/index.ts` |
| HIGH | PERCENT voucher `maxAmount` cap silently bypassed | Thread `maxAmount` through `validate()` → `voucherMeta` → `computeTotals` | `packages/domain/src/commerce/voucher.service.ts`, `checkout.service.ts` |
| HIGH | TOCTOU double-spend in `requestDisbursement` | Transaction-scoped `pg_advisory_xact_lock(hashtext(memberId))` serialises concurrent requests | `packages/domain/src/affiliate/disbursement.service.ts` |
| HIGH | Self-referral / circular inviter-chain pays buyer on own purchase | `cutChainCycles()` cycle-guard in `walkInviterChain` + skip `node.id === buyerMemberId` in commit loop | `packages/domain/src/affiliate/utils/walk-inviter-chain.ts`, `affiliator.service.ts` |
| MEDIUM | Password change did not revoke other sessions | `changePassword` now revokes all non-revoked refresh tokens (mirrors `resetPassword`) | `apps/mobile-api/src/modules/account/account.service.ts` |
| MEDIUM | Unbounded multipart upload (memory/S3 DoS) | `limits.files`/`parts` cap + `upload.array('image', MAX)` (MAX=10) | `apps/mobile-api/src/modules/upload/upload.routes.ts` |
| LOW | Swagger UI + OpenAPI JSON exposed in prod | Gated behind `API_DOCS_ENABLED` flag (default ON, so staging keeps docs; set `=false` in real production) | `packages/common/src/openapi/swagger.middleware.ts`, `config/env.ts` |
| LOW | Voucher-validate enumeration (no rate limit) | Per-member `voucherValidateRateLimiter` (20/15min) on the route | `packages/common/src/middlewares/rate-limit.middleware.ts`, `apps/mobile-api/.../commerce.routes.ts` |

New regression tests: `network-auth.spec.ts`, `admin-rbac.spec.ts`,
`affiliate/inviter-chain-cycle.spec.ts`, voucher-`maxAmount` case in
`commerce/voucher.spec.ts`. `api-smoke.spec.ts` network assertions updated to the
auth-gated behaviour.

---

## ⏸️ Deferred — need design/schema, not a quick patch

### #6 — Refresh-token reuse detection (MEDIUM)
Proper RTR reuse-detection (revoke the whole session family when a **rotated** token is
replayed) requires distinguishing a rotation-reuse *attack* from a token revoked for
**benign** reasons (second login in the single-session mobile bucket, logout, password
change). A blanket "any revoked token presented → revoke family" (attempted and reverted)
logs legitimate users out and breaks `auth-single-session.spec.ts`.

**Design:** add a lineage column to `RefreshToken` (e.g. `supersededById String?` set
during `rotateRefreshToken`). On reuse, only revoke the family when the presented revoked
token has a still-live successor in its lineage. Schema migration + targeted tests.

### #8 — Voucher quota oversell under concurrency (MEDIUM)
`validate()` checks `used < quota` at checkout (non-locking read) but the atomic
`redeem()` only runs at payment-success, so N concurrent checkouts can all settle a
limited-quota promo. True fix = **reserve at checkout** (atomic `used++` with
`WHERE used < quota`) + **release on cancel/expire**, finalise (no-op) on success.
Needs a per-transaction reservation marker so release is exactly-once (avoid
double-decrement), touching `checkout.service`, `payment.service.cancel`, and the
expire cron. Bounded impact today (marketing-budget overrun, not unbounded), so deferred
to a focused PR with concurrency tests.

### Migration history repair (tooling)
`prisma migrate deploy` from an empty DB fails at
`20260525075123_add_is_curated_to_post_and_comment` (drops a non-existent constraint).
Repair the migration (guard the `DROP CONSTRAINT` / re-baseline) so fresh environments
and CI can migrate cleanly.

---

## 🧹 Clean-code themes (28 findings) — not yet done

Lower-risk quality work, grouped by theme (full list in the audit output):

1. **Env-config drift** — ≥6 modules read `process.env` directly instead of
   `packages/common/src/config/env.ts`. Notably `PUBLIC_WEB_URL` (hardcoded
   `brainboost.com` fallback, duplicated 4×: product serializer ×2, product controller,
   post serializer) and `system-config.service` (11 raw env vars incl. withdrawal limits).
2. **DRY duplication** — bearer-parse ×4 guards; timing-safe compare ×3; `HandleResult`
   ×2; `resolveCountry/Province/City/District` (4 identical); `resolveNetworkId`
   (network/topic); media token+enrollment gate (stream/download); share-URL/affCode ×3.
3. **Validation bypass** — affiliate `logVisit/setMode/logAttribution`, profile
   update/location, media query params, `getTransactionStatus` path param skip
   `validateDto`.
4. **Controller altitude** — `shareCourse` does Prisma + URL assembly in the controller;
   admin curate routes hand-roll JSON envelopes instead of `ok()`.
5. **Dead code / stale contracts** — commented `ACCOUNT_NOT_VERIFIED` branch,
   `ReportController.postReport` (unrouted), `getPaymentToken` stub (latent IDOR),
   stale OpenAPI descriptions, OTP DTO `@Length(4,8)` vs 6-digit issuance.
6. **Info-disclosure micro-gaps** — JWT no iss/aud assert, 403-vs-404 order existence
   leak, `courseDetail`/`shareCourse` no `isActive` filter.

---

## ⚠️ Operational note
The integration suite was inadvertently run twice against the staging DB (via the
`localhost:5433` tunnel) before it was known to be staging. Integration specs are largely
self-cleaning (timestamped keys + `afterAll` deletes), so residue should be minimal, but
a spot-check of staging for orphaned `T-…`/test-prefixed rows is advisable.

## Follow-up: network PII minimisation
`serializeNetworkMemberLegacy` still returns email/phone/birthdate/address for every
listed member. Now that the route is auth-gated this is no longer an anonymous leak, but
exposing the whole member base's contact PII to any logged-in user is over-exposure —
strip contact fields (or scope to network team members). Needs FE coordination since the
flat `NetworkMemberModel` declares those fields.
