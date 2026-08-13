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

- `memberRef` — see **Member resolution** below.
- `productRef.bySku = event.product_id` → resolved against `Product.iosProductId`.
- `grossAmount = event.price_in_purchased_currency` (local IDR, **not** `event.price`
  which is USD).
- **Idempotency / refund linkage key:** PURCHASE keys on `transaction_id` (the RC
  `CANCELLATION` carries the same `transaction_id`, not the purchase's `event.id`).
  REFUND uses its own `event.id` as `providerEventId` and
  `refundOfProviderEventId = transaction_id`.

## Member resolution (`app_user_id` is not always a UUID)

`app_user_id` only carries `Member.id` once the app has called
`Purchases.logIn()`. A purchase completed before that — or after a
reinstall/logout — arrives as RC's anonymous id instead:

```json
{ "app_user_id": "$RCAnonymousID:1384062dfb284e6883fafe704b2bb252",
  "aliases": ["$RCAnonymousID:1384062dfb284e6883fafe704b2bb252"] }
```

`RevenueCatWebhookHandler.memberRef()` resolves in this order:

1. **first UUID** among `app_user_id` → `original_app_user_id` → `aliases`
   (RC backfills `aliases` with the real id when the SDK aliases an anonymous
   customer later, so the id is often still recoverable);
2. else `subscriber_attributes.$email.value` → `memberRef.byEmail`, matched
   case-insensitively against `members.email`.

Anonymous ids are **dropped**, never passed through as `byId`. This is the
whole point of the guard: `members.id` is `@db.Uuid`, so
`findUnique({ where: { id: '$RCAnonymousID:…' } })` throws Prisma **P2023**,
which `errorHandler` maps to **400** — RC then exhausts its retries and the
event is lost for good (member paid, no access), and the `$email` fallback in
`resolveMember` never runs because the throw happens first. `isUuid()` guards
both `resolveMember` and `resolveProduct` in `purchaseIngestService` so every
ingest channel is covered, not just RC.

When nothing resolves, the ingest returns `member_not_found` and the handler
logs at **warn** (`[revenuecat] ingested`, with `appUserId` + `memberRef`) —
the response is still 200, so this log line is the only alertable signal that a
paid purchase went ungranted.

## Burst handling (IAP-restore flood)

RC can deliver many events in the same instant (e.g. an IAP restore replays
every past `NON_RENEWING_PURCHASE`). Two consequences were hardened:

- **Order-code collision.** `generateOrderCode` derives a per-day sequence from
  a `COUNT(*)` → concurrent inserts read the same count and collide on the
  `code` unique. `purchaseIngestService.ingest` now retries (up to 5×) with a
  jittered code (`generateOrderCode(now, { jitter: true })` → random hex
  suffix). Critically, a `code` P2002 is **no longer** misclassified as a
  duplicate: on any P2002 the ingest disambiguates via the `(provider,
  providerEventId)` idempotency key — only a real match returns `duplicate`,
  otherwise it retries. (Before: a code collision was silently dropped as a
  duplicate → member paid, no access.)
- **Enrollment re-grant noise.** The success listener grants the enrollment via
  `createMany({ skipDuplicates: true })` instead of `create`+catch, so a
  re-delivered event no longer emits a swallowed `prisma:error` P2002 line.

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
course_id) is migrated into `Product.iosProductId` once via:

```
pnpm seed:revenuecat-iap            # apply
pnpm tsx scripts/seed-revenuecat-iap.ts --dry-run   # report only
```

Bridge: `RC product_id ──map──▶ legacy course_id ──Course.legacyCourseId──▶ Product`.
After seeding, the webhook resolves products purely via `iosProductId` — no app-code
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

## Currency: foreign storefronts (fixed 2026-08-13)

`price_in_purchased_currency` is in the **buyer's storefront currency**, not IDR. The
handler used to pass it straight through as rupiah, so an A$39.99 purchase was stored as
`amount = 40` and paid a **Rp5** affiliate commission (payment `019ff63c-9ee7…`). 9 of 61
RevenueCat payments were affected (HKD 3, MYR 2, SGD 2, USD 1, AUD 1); all were repaired
by `scripts/backfill-rc-currency.ts` (idempotent, stamps `log_response.backfill`).

**Bridge = USD.** Every event carries `price` in USD regardless of storefront (verified: a
USD-storefront event has `price == price_in_purchased_currency` exactly; the HKD one lands
on the 7.75–7.85 peg). So ONE pair, `USD/IDR`, covers every storefront present and future —
we never store per-currency rates.

```
amountIdr = round(price_usd × usdIdrRate)
accepted  = floor(amountIdr × (netAmount / grossAmount))   # ratio, not a fresh %
```

`FxRateService.getUsdIdr()` (`packages/common/src/services/fx-rate.service.ts`) resolves in
order — first layer that answers wins, never dead-ends:

1. in-process cache, keyed by UTC day (6 h TTL)
2. `fx.usdIdrPinned` + `fx.usdIdr` in `app_settings` → source `manual` (ops kill-switch)
3. FX API: `api.frankfurter.dev/v1` (ECB) → `open.er-api.com` → source `api`
4. derived from our own IDR RevenueCat payments (`price_in_purchased_currency / price`,
   ≤7 days back) → source `revenuecat_derived`
5. `fx.usdIdr` unpinned / `FX_STATIC_USD_IDR` → source `static`
6. caller's floor: `product.iosPrice`, logged at **error**, source `catalog_fallback`

Layer 4 is exact — an IDR event carries both legs of the pair, so its ratio is the rate RC
billed with. It sits below the API only because it needs a recent IDR sale to exist.
Measured drift between the two: **0.082 %** (Frankfurter 17 843 vs derived 17 828.42 on
2026-08-12), so the ordering costs nothing.

**Sanity band.** A converted amount outside `0.25×–4×` the catalog price is refused and
replaced by the catalog price. Foreign tiers legitimately run 1.03×–1.26× the Indonesian
one; the live bug scored 0.0001×.

**Snapshot columns** on `commerce_payments` (migration `20260813120000_add_payment_fx_snapshot`),
all NULL on the IDR path: `currency`, `amount_local`, `amount_usd`, `fx_rate_idr`,
`fx_rate_source`. The rate lives on the payment, not in a rates table, because the rate a
row used must stay reproducible after the live rate moves on. `amount`/`accepted_amount`
stay IDR integers, so commission/reporting/history remain currency-blind.

**Cadence.** ECB publishes once per business day (~16:00 CET); a weekend query returns the
last business day and echoes that date. Calling more than daily cannot produce a new
number, which is why the cache is day-keyed.

### Open: `takehome_percentage` is measured on a different base than `price`

`takehome_percentage` is **0.7 in every tax regime observed** (IDR, AUD, SGD, MYR, HKD,
USD) while `commission_percentage` tracks tax exactly (`0.3 × (1 − tax)` in all six). That
only holds if takehome is a share of the **ex-tax** price, whereas `price` is tax-inclusive
— so `gross × takehome` overstates net by `1/(1 − tax)`: **+11 % ID**, +10 % AU, +9 % SG,
+8 % MY, 0 % HK/US. True proceeds would be `gross × (1 − commission − tax)`.

Not changed — deliberately deferred. Overpaid commission so far: **Rp13 840** across 4 rows,
all still `PENDING`. **Verify against one month of App Store Connect → Payments and
Financial Reports before correcting**: 0.6306 is derived from Apple's stated rule, not from
a bank settlement. The fallback branch `(1-c)(1-t)` in `computeNetAmount` is also wrong for
a different reason (it double-counts tax, since `c` is already tax-adjusted).

### Also fixed alongside

- **Sandbox guard.** `environment`, `store`, `event_timestamp_ms` were dropped by the DTO
  whitelist. Sandbox events carry `price: 0`, which would now hit the catalog fallback and
  record a full-price sale, so a SANDBOX event in production is refused (200, not ingested).
- **Google Play SKUs.** `resolveProduct` matched `iosProductId` only — a Play purchase
  returned `product_not_found` (member paid, no access, provider given a 200 so it never
  retried). Now matches either SKU column.

## Env

- `FX_PRIMARY_URL` / `FX_FALLBACK_URL` — keyless FX providers (defaults above). Note
  `api.frankfurter.app` now 301s via Cloudflare; use `api.frankfurter.dev/v1`.
- `FX_TIMEOUT_MS` (3000) — short on purpose: this sits in the webhook path and must
  degrade to the next layer, never stall the 200. ~1 in 5 probe calls timed out.
- `FX_DERIVED_MAX_AGE_DAYS` (7) — staleness bound for layer 4. Worst observed gap between
  IDR purchases is ~2 days.
- `FX_STATIC_USD_IDR` (17800) — last-resort rate, also what `fx.usdIdrPinned` promotes.
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
- `packages/common/src/services/fx-rate.service.ts` (USD→IDR resolution chain)
- `packages/common/src/config/env.ts` (`revenuecat` + `fx` blocks)
- `scripts/backfill-rc-currency.ts` (one-off repair, idempotent, re-runnable)
- `apps/mobile-api/tests/ingest/fx-normalization.spec.ts`
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
