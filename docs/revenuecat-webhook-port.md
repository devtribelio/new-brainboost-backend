# RevenueCat webhook port (Supabase edge fn → in-backend)

Moves the standalone Supabase edge function (`revenuecat-ios/`) into the new
backend. The edge function bridged RC → **legacy** Tribeversity over HTTP; the
in-backend version feeds the **ingestion kernel** instead, so an IAP purchase
grants `CourseEnrollment` directly (→ `isPurchased: true`) and a refund revokes it.

## Endpoint

`POST /api/webhook/revenuecat`

- Auth: `Authorization` header == the `revenuecat` credential's secret, stored
  **in the DB** as `ThirdPartyCredential.keyHash` (hash only). The guard verifies
  the header against it (constant-time), fails closed. Accepts the value with or
  without a `Bearer ` prefix. `env.REVENUECAT_WEBHOOK_AUTH` is an OPTIONAL
  bootstrap/emergency fallback (leave unset in steady state). **Leaked secret →
  rotate via a single command, no redeploy** (see "Rotating the secret").
- Body: RC webhook envelope `{ event: {...}, api_version }`. `event.type` + `event.id`
  required; rest optional.
- Always returns `200` on a processed event (so RC stops retrying resolved
  outcomes). Genuine transient failures (DB down) throw → `errorHandler` 5xx → RC retries.

## Flow

```
RC webhook ─▶ revenueCatCallbackGuard (shared secret)
          ─▶ validateDto(RevenueCatCallbackDto)
          ─▶ RevenueCatWebhookHandler
               • filter event type
               • load `revenuecat` ThirdPartyCredential by NAME (for toggles)
               • map RC event → NormalizedPurchase
               • purchaseIngestService.ingest()
                    → commerce.payment.success → grant CourseEnrollment (isPurchased)
                    → REFUND → void commissions + delete CourseEnrollment
```

The whole legacy-forwarding layer of the edge fn is **dropped**: no OAuth
login/token cache, no `postPayment`, no MariaDB lookup. Writes go straight to
Postgres via the kernel.

## Event mapping

| RC event type | ingest type |
|---|---|
| `INITIAL_PURCHASE`, `RENEWAL`, `NON_RENEWING_PURCHASE`, `PRODUCT_CHANGE` | `PURCHASE` |
| `CANCELLATION` | `REFUND` |
| anything else | skipped (200, no ingest) |

`NormalizedPurchase` mapping:

- `memberRef.byId = event.app_user_id` (the new `Member.id` UUID set by the iOS
  SDK), fallback `byEmail = subscriber_attributes.$email`.
- `productRef.bySku = event.product_id` → resolved against `Product.iapProductId`.
- `grossAmount = event.price_in_purchased_currency` (local IDR, **not** `event.price`
  which is USD).
- **Idempotency / refund linkage key:** PURCHASE keys on `transaction_id` (the RC
  `CANCELLATION` carries the same `transaction_id`, not the purchase's `event.id`).
  REFUND uses its own `event.id` as `providerEventId` and
  `refundOfProviderEventId = transaction_id`.

## Refund revokes access

`PurchaseIngestService.handleRefund` was extended to **delete** the buyer's
`CourseEnrollment` for the refunded course (in addition to voiding commissions +
marking the tx `REFUNDED`). Rationale: every read path that drives `isPurchased`
(product list `batchPurchased`, course-detail `isPurchase`, media `assertEnrollment`)
keys on enrollment row existence, so a hard delete is the single point that
revokes access everywhere. A later re-purchase re-creates the enrollment via the
success listener. Idempotent (`deleteMany`).

## Product mapping seed

The edge fn's hardcoded `productMap.ts` (66 entries: RC product_id → legacy
course_id) is migrated into `Product.iapProductId` once via:

```
pnpm seed:revenuecat-iap            # apply
pnpm tsx scripts/seed-revenuecat-iap.ts --dry-run   # report only
```

Bridge: `RC product_id ──map──▶ legacy course_id ──Course.legacyCourseId──▶ Product`.
After seeding, the webhook resolves products purely via `iapProductId` — no app-code
map. Re-runnable; reports `missing` (no Course with that `legacyCourseId` — backfill
`Course.legacyCourseId` first) and `conflicts`.

## Credential

Per-channel toggles live on the `revenuecat` `ThirdPartyCredential` row. Issue it
(IAP pays no affiliate commission — Apple already took its cut — but a refund must
void/revoke):

```
pnpm issue:credential revenuecat --refund        # triggersAffiliate=false, canIngestRefund=true
```

The handler loads the row by name (`credentialService.verifyByName`) for its
toggles. The **guard** authenticates the request against the same row's `keyHash`
(`credentialService.verifySecret`). So the one `revenuecat` row does double duty:
**auth** (keyHash) + **toggles** (triggersAffiliate / canIngestRefund).

## Rotating the secret

The shared secret IS the credential key — stored hashed, rotatable without a
redeploy:

```
pnpm issue:credential revenuecat --refund   # upsert: prints a NEW key ONCE
```

1. Copy the printed `bbk_...` key (shown once; DB keeps only the hash).
2. Paste it into the RC dashboard → webhook → Authorization header.
3. The old key is dead immediately. Brief 401s during the swap are fine — RC
   retries. No dual-secret window is implemented (kept simple).

The same command is used for the very first issue. `--refund` →
`canIngestRefund=true`; omitting `--affiliate` → `triggersAffiliate=false`.

## Env

- `REVENUECAT_WEBHOOK_AUTH` — OPTIONAL bootstrap/emergency fallback secret. The
  steady-state secret lives in the DB (`revenuecat` credential `keyHash`); leave
  this unset once that row exists. If set, a matching header still passes (so the
  endpoint isn't bricked when the DB row is missing). **TODO: add to `.env.example`**
  (permission denied this session).
- `REVENUECAT_PROVIDER_NAME` — defaults to `revenuecat`; must match the credential
  row name (used by both the guard's `verifySecret` and the handler's toggle load).

## Files

- `apps/mobile-api/src/modules/webhook/revenuecat.handler.ts`
- `apps/mobile-api/src/modules/webhook/revenuecat-callback.guard.ts`
- `apps/mobile-api/src/modules/webhook/dto/revenuecat-callback.dto.ts`
- `apps/mobile-api/src/modules/webhook/webhook.controller.ts` / `webhook.routes.ts` (wired)
- `apps/mobile-api/src/modules/ingest/credential.service.ts` (`verifyByName`)
- `apps/mobile-api/src/modules/ingest/purchase-ingest.service.ts` (`handleRefund` revoke enrollment)
- `packages/common/src/config/env.ts` (`revenuecat` block)
- `scripts/seed-revenuecat-iap.ts` (+ `seed:revenuecat-iap` script)
- `apps/mobile-api/tests/commerce/revenuecat-webhook.spec.ts`

## Deploy checklist

1. `pnpm issue:credential revenuecat --refund` (store the printed key — unused by
   the webhook but keeps the row consistent with other channels).
2. Backfill `Course.legacyCourseId`, then `pnpm seed:revenuecat-iap` (check the
   summary for `missing`/`conflicts`).
3. Set `REVENUECAT_WEBHOOK_AUTH` in the deploy env.
4. Point RC dashboard webhook at `https://<host>/api/webhook/revenuecat` with the
   matching `Authorization` value.
5. Confirm iOS sets RC `app_user_id` = the new `Member.id` (UUID).
6. Decommission the Supabase edge function.
