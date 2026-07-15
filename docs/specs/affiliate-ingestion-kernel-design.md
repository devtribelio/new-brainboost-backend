# Design: Affiliate Ingestion Kernel (multi-channel commission)

Status: **DRAFT — for review**
Owner: (assign)
Last updated: 2026-05-21

---

## 1. Context & problem

Affiliate commission today is wired per-channel and inconsistently:

- **New backend (web/Xendit):** purchase → `commerce.payment.success` event → `AffiliatorService.commitCommissionsForPayment()` → commission. Works.
- **Legacy Tribelio:** affiliate only fires for (a) products bought via an affiliate link (`member_product_affiliator_id` set) or (b) the BrainBoost web flow (`source == 'brainboost'`). **Scalev (`/api/client/transaction/payment`) does NOT trigger affiliate at all** — it dispatches only `OnCoursePaymentSuccess` (not `OnCoursePaymentCompleted` where `shareCommision` lives) and sets no affiliate fields. Verified in `PaymentSubscriber.php:653/701/707` + `TBTribeversityApi/Client/Method/Transaction/Payment.php:232-277`.

We are about to add more purchase channels — **IAP (RevenueCat), Scalev, Lynk.id**. We do NOT want to keep editing core code per channel.

**Goal:** a stable core "kernel" that any channel can feed, where *whether a channel pays affiliate is config, not code*.

---

## 2. Goals / non-goals

**Goals**
- One **normalized** ingestion path for all purchase channels.
- Adding a channel = create a credential + (optionally) a thin external adapter. **Core untouched.**
- Per-channel **toggle** for affiliate (enable/disable without deploy).
- Reuse the existing commission engine + attribution unchanged.
- Safe-by-default: a new channel does NOT pay commission until explicitly enabled.

**Non-goals (for this doc)**
- Changing commission math (GROWTH/PERFORMANCE/INACTIVE) — stays as-is, parity-verified.
- Building an admin UI (raw SQL / future endpoint is fine to start).
- Payout/Xendit-disbursement provider wiring (separate track).

---

## 3. Architecture overview

```
                         ┌─────────────────────────── CORE (stable kernel) ───────────────────────────┐
 RevenueCat ──webhook──▶ │                                                                             │
 Scalev     ──webhook──▶ │  POST /ingest/purchase   (auth: ThirdPartyCredential)                       │
 Lynk.id    ──webhook──▶ │        │                                                                     │
 (web/Xendit already)    │        ▼                                                                     │
                         │  purchase-ingest.service                                                     │
                         │   1. validate NormalizedPurchase                                             │
                         │   2. resolve member + product                                                │
                         │   3. record purchase (idempotent by providerEventId)                         │
                         │   4. IF credential.triggersAffiliate → resolve attribution → emit event      │
                         │        └─▶ commerce.payment.success ─▶ AffiliatorService.commit... (engine)  │
                         └─────────────────────────────────────────────────────────────────────────────┘
```

**DECISION (2026-05-21): external serverless/edge adapter per provider.** Every channel
(RevenueCat, Scalev, Lynk.id, …) gets its own edge function that verifies the provider's own
webhook signature, transforms the payload → `NormalizedPurchase`, and calls the core
`/ingest/purchase` with its credential key. The **core never changes per provider** — adding/
adjusting an integration is isolated to its edge function.

> We deliberately do **NOT** reuse the legacy `/api/client/transaction/payment` path/contract.
> The legacy and new databases differ substantially, so a clean break is preferred; and since
> each provider already needs its own edge function, the per-provider change stays there (just
> repoint to `/ingest/purchase` + map payload). Scalev too goes through an edge function, not a
> legacy-compatible endpoint.

(An in-backend `*.adapter.ts` is still possible for anything we'd rather keep inside the
service, but the default for new 3rd parties is an edge function → `/ingest/purchase`.)

---

## 4. `ThirdPartyCredential` (auth + per-channel toggles)

Boolean toggles (chosen over a scopes array for easy manual DB edits).

```prisma
model ThirdPartyCredential {
  id                String   @id @default(uuid(7)) @db.Uuid
  name              String   @unique            // "scalev", "revenuecat", "lynkid"
  keyHash           String   @unique            // store a HASH of the API key, never plaintext
  isActive          Boolean  @default(true)     // master on/off for the integration
  triggersAffiliate Boolean  @default(false)    // ← affiliate toggle; SAFE DEFAULT = off
  canIngestRefund   Boolean  @default(false)    // may void commissions on refund events
  lastUsedAt        DateTime?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@map("third_party_credentials")
}
```

- **Issue a key:** generate a random key, store `keyHash` (bcrypt/sha256), hand the plaintext to the integration once.
- **Auth:** `Authorization: Bearer <key>` → look up by hash → check `isActive`. (Mirrors `xendit-callback.guard.ts`, but generic + multi-tenant.)
- **Toggle affiliate (no deploy):**
  ```sql
  UPDATE third_party_credentials SET "triggersAffiliate" = true WHERE name = 'scalev';
  ```
- New capability later = +1 boolean column (small migration). Acceptable — capability set is small & stable.

---

## 5. `NormalizedPurchase` contract (the stable internal shape)

Every channel maps its payload to this:

```ts
interface NormalizedPurchase {
  provider: string;            // = credential.name (set server-side from the authenticated credential)
  providerEventId: string;     // idempotency key (e.g. RevenueCat transaction_id, Scalev event_id)
  type: 'PURCHASE' | 'REFUND';
  // who bought — at least one ref must resolve to a Member
  memberRef: { byId?: string; byEmail?: string; byExternalId?: string };
  // what was bought — resolves to a Product
  productRef: { byId?: string; bySku?: string };
  grossAmount: number;         // integer minor unit / IDR (see Open Decision #2)
  voucherAmount?: number;      // default 0
  currency: string;            // "IDR", "USD", ...
  affiliatorCode?: string;     // explicit per-purchase attribution if the channel carries it
  occurredAt: string;          // ISO
  raw?: unknown;               // original payload, stored for audit
}
```

Resolution helpers needed in core:
- `resolveMember(memberRef)` — by id → email → externalId.
- `resolveProduct(productRef)` — by id → SKU. **Needs a SKU mapping** (new `Product.iapProductId` / store-sku column or mapping table) for IAP.

---

## 6. Ingestion flow (sequence)

```
1. Adapter/provider → POST /ingest/purchase  (Authorization: Bearer <key>, body: NormalizedPurchase)
2. credentialGuard: hash-lookup key → isActive? → attach credential to req
3. purchase-ingest.service.ingest(normalized, credential):
   a. resolve member + product (skip + log if unresolved)
   b. upsert a purchase record keyed by (provider, providerEventId)  ← idempotent
   c. if type == REFUND:
        if credential.canIngestRefund → void matching commissions (status VOIDED)
   d. if type == PURCHASE and credential.triggersAffiliate:
        overrideAffiliatorMemberId = resolveOverride(memberId, normalized.affiliatorCode)
        emit commerce.payment.success { paymentId, productId, productPrice, voucherAmount,
                                        buyerMemberId, programId: null, overrideAffiliatorMemberId }
   e. else: record purchase only (no commission)
4. existing listener → AffiliatorService.commitCommissionsForPayment(...) → commission rows
```

`commitCommissionsForPayment` is unchanged (already supports `overrideAffiliatorMemberId`, programId optional).

---

## 7. Attribution (recap of decided model)

Recipient seed precedence (already implemented for web):
1. **Explicit `affiliatorCode`** on the purchase (per-purchase override) →
2. **Last-touch within window** — web: `bb_aff` cookie (1yr); app: most-recent `AffiliateVisit` within `affiliate.cookieDays` (app_settings) →
3. **Permanent `inviterId`** (set at registration via affiliate link / install-referrer) →
4. none → no commission.

`resolveOverride(memberId, explicitCode?)` should be **one shared function** used by web checkout AND `/ingest/purchase`. (Today the logic lives in checkout; unify it.)

- **Web:** cookie carries last-touch.
- **App / IAP:** no cookie in StoreKit; either the app sends `affiliatorCode` (RevenueCat subscriber attribute → webhook → `NormalizedPurchase.affiliatorCode`) OR the app logs an `AffiliateVisit` when opening a deeplink → core resolves the most-recent visit within window. Recommended: **server-side visit** (reuses `POST /affiliate/visits` + the same window config).
- Prereq: make `AffiliateVisit.programId` **nullable** (generic affiliator deeplink, no specific program). (Currently required.)

---

## 8. Per-channel behavior (config, not code)

| Channel | Auth | triggersAffiliate (default) | Notes |
|---|---|---|---|
| Web (Xendit) | existing `x-callback-token` guard | n/a (already wired via event) | could be folded into the kernel later for uniformity |
| **Scalev** | ThirdPartyCredential (via edge fn → `/ingest/purchase`) | **false** (matches legacy — Scalev never paid affiliate) | edge function maps Scalev payload → NormalizedPurchase; flip to `true` when business decides Scalev should pay uplines |
| **IAP / RevenueCat** | ThirdPartyCredential | **true** (intended) | attribution = inviter or visit/subscriber-attribute override |
| **Lynk.id** | ThirdPartyCredential | **false** initially | enable when ready |

This is the key win vs legacy: **which channels pay affiliate is a DB toggle**, and the new system can make all channels consistent (legacy left Scalev out with no way to change without code).

---

## 9. Idempotency, security, money-safety

- **Idempotency:** `(provider, providerEventId)` unique on the purchase record + existing commission unique `(paymentId, recipientId, level)`. Re-delivered webhooks are no-ops.
- **Keys hashed at rest**, revocable (`isActive=false`), `lastUsedAt` for audit.
- **Least privilege:** a credential can ingest purchases but only pays commission if `triggersAffiliate`. Refund/void only if `canIngestRefund`.
- **Provider signature verification is the adapter's job** (RevenueCat Authorization header, Scalev/Lynk.id HMAC). Core trusts the credential; the adapter must verify the provider first.
- **Rate limit + audit log** on `/ingest/purchase` (it can move money).
- A leaked credential = forged commissions → treat keys like payment secrets.

---

## 10. What's reused vs new

**Reused (no change):**
- `AffiliatorService.commitCommissionsForPayment` (engine, override support).
- `commerce.payment.success` event + listener.
- `AffiliateVisit` + `POST /affiliate/visits` (attribution source).
- `app_settings` (`affiliate.cookieDays`, `affiliate.holdDays`) for windows.
- Disbursement service (payout rules 15k/5k/>10k).

**New:**
- `ThirdPartyCredential` table + `credentialGuard` + key-issue/revoke helper.
- `POST /ingest/purchase` + `purchase-ingest.service` + `NormalizedPurchase`.
- Shared `resolveOverride()` (unify checkout + ingest).
- `Product` store-SKU mapping (e.g. `iapProductId`) + nullable `AffiliateVisit.programId`.
- Per-provider adapter (serverless or in-backend) — RevenueCat first.

---

## 11. Rollout plan (suggested)

1. Kernel: `ThirdPartyCredential` + guard + `/ingest/purchase` + ingest service + `NormalizedPurchase` (+ unify `resolveOverride`).
2. Product SKU mapping + nullable `AffiliateVisit.programId` migrations.
3. RevenueCat adapter (first consumer), `triggersAffiliate=true`. Validate IAP → commission end-to-end on staging.
4. Scalev adapter, `triggersAffiliate=false` (parity), flip on when product decides.
5. (Optional) refactor Xendit/web into the kernel for uniformity.
6. (Separate track) PENDING→BALANCE cron + payout provider.

---

## 12. Open decisions (need product/eng sign-off)

1. ~~**Architecture:** external serverless adapters vs in-backend adapters?~~ **RESOLVED 2026-05-21: external serverless/edge adapters per provider → `/ingest/purchase`. Legacy path NOT reused (DBs differ; per-provider change isolated to the edge function).**
2. **IAP commission base:** gross store price (what user paid) or net after Apple's 15–30% cut? RevenueCat reports both.
3. **Subscriptions:** commission on initial purchase only, or on each renewal (RevenueCat `RENEWAL`)?
4. **Currency:** convert store currency → IDR at ingest, or store per-currency + convert at payout?
5. **Which channels should `triggersAffiliate=true` at launch?** (Proposed: RevenueCat yes; Scalev/Lynk.id no until decided.)
6. **App attribution mechanism:** RevenueCat subscriber attribute vs server-side `AffiliateVisit`? (Doc recommends visit.)
7. **Refund handling depth:** auto-void commission on refund? clawback if already paid out?

---

## Appendix A — Legacy reference (why Scalev doesn't pay today)
- `TBTribeversityApi/Client/Method/Transaction/Payment.php` builds `CoursePayment` with `source = <clientName>`, no `affiliator_code` / `member_product_affiliator_id`, dispatches only `OnCoursePaymentSuccess`.
- `PaymentSubscriber::handleOnCoursePaymentCompleted` (line 707) is the only place calling `TBAffiliator::shareCommision('CoursePayment')`, gated on `member_product_affiliator_id` set OR `source=='brainboost'` — neither true for Scalev. And `OnCoursePaymentCompleted` is not dispatched by the Scalev path.
