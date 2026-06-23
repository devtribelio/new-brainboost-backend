# Commerce / Purchase — Porting Tracker

**Status:** P1-P7 implemented. Migrated to `xendit-node` SDK (unified PaymentRequest). Manual sandbox QA pending.
**Owner:** brainboost@tribelio.com
**Last updated:** 2026-05-18
**Scope:** Xendit-only checkout (CC + VA + eWallet) via `xendit-node@7` SDK. IAP, cart, shipping, subscription, FB pixel — **dropped / deferred**.
**Plan source:** `/home/cold/.claude-bb/plans/bagaimana-cara-pembelian-product-composed-valley.md`
**Legacy source:** `tribelio-platform` — `Controller_Commerce`, `Controller_Payment`, `Controller_Product`, `TBCommerce`, `TBXendit`.

---

## 1. Scope Decisions

| Topic | Decision | Rationale |
|---|---|---|
| Gateway | Xendit only (CC, VA, eWallet) | Legacy `TBCommerce::payment` switch case hanya 3 branch, semua via Xendit |
| IAP (Apple/Google) | Dropped | User confirmed skip. Subscription plan defer ke phase berikutnya |
| Cart (multi-item) | Dropped | Mobile-only; course = single-product checkout |
| Shipping | Dropped | No physical product di MVP |
| Voucher | Implemented (model penuh) | Parity legacy bypass-charge flow + admin manage |
| Path style | Mimic legacy (`/product/checkout`, `/payment/commerce`) | Konsisten dengan `product.routes.ts` existing |
| Checkout/payment | 2-step (preTx → payment) | Audit price snapshot, parity legacy `CommercePreTransaction` |
| FB pixel callback | Dropped | Legacy feature, not requested |
| TBBalance::history | Deferred | Backlog post-MVP |
| TBCustomer CRM tag | Deferred | Backlog post-MVP |

---

## 2. Data Model

### Schema additions (`prisma/schema.prisma`)

#### Enums

```prisma
enum CommerceTransactionStatus {
  PENDING
  PAID
  EXPIRED
  FAILED
  REFUNDED
  CANCELED
}

enum CommercePaymentStatus {
  PENDING
  SUCCESS
  EXPIRED
  FAILED
  CANCELED
}
```

#### `commerce_transactions` (`CommerceTransaction`)

Order header. Created at checkout, finalized saat payment SUCCESS.

| Kolom | Tipe | Catatan |
|---|---|---|
| `id` | uuid v7 PK | |
| `legacyId` | int? unique | Legacy `commerce_transaction.id` |
| `code` | string unique | Human-readable: `BB-YYYYMMDD-####` |
| `memberId` | uuid FK Member | Buyer |
| `productId` | uuid FK Product | Course product |
| `qty` | int default 1 | Reserved untuk forward-compat (selalu 1 di MVP) |
| `itemTotal` | int | Harga product × qty |
| `shippingTotal` | int default 0 | Reserved (no shipping di MVP) |
| `feeTotal` | int | Gateway fee snapshot |
| `voucherAmount` | int | Diskon dari voucher |
| `amount` | int | Grand total = item + shipping + fee − voucher |
| `voucherCode` | string? | Snapshot kode voucher |
| `affiliatorId` | uuid? FK MemberAffiliator | Attribution last-touch |
| `programId` | uuid? FK AffiliateProgram | |
| `status` | enum `CommerceTransactionStatus` | |
| `paidAt` | datetime? | Set saat payment success |
| `canceledAt` | datetime? | |
| `expiredAt` | datetime? | now+24h saat checkout |
| `createdAt`, `updatedAt` | datetime | |

Index: `(memberId, createdAt)`, `(status)`.

#### `commerce_payments` (`CommercePayment`)

Payment attempt. Multi row per transaction kalau retry VA setelah expired.

| Kolom | Tipe | Catatan |
|---|---|---|
| `id` | uuid v7 PK | |
| `legacyId` | int? unique | Legacy `commerce_payment.id` |
| `transactionId` | uuid FK CommerceTransaction | |
| `memberId` | uuid FK Member | |
| `paymentType` | string | `cc` \| `va` \| `eWallet` \| `voucher` |
| `bank` | string? | BCA / BNI / MANDIRI / BRI / PERMATA (saat VA) |
| `ewalletType` | string? | OVO / DANA / LINKAJA / GOPAY / SHOPEEPAY |
| `amount` | int | Total charge |
| `fee` | int default 0 | Gateway fee untuk attempt ini |
| `acceptedAmount` | int default 0 | Diisi saat status SUCCESS |
| `status` | enum `CommercePaymentStatus` | |
| `vendorStatus` | string? | Raw Xendit status string |
| `externalId` | string? | `commerce-{uuidv7}` |
| `xenditId` | string? unique | Xendit charge/VA/ewallet id |
| `xenditVaId` | string? | VA-specific id |
| `vaNumber` | string? | Display di mobile |
| `cardTokenId` | string? | Xendit.js token (CC) |
| `cardMaskedNumber` | string? | |
| `cardBrand` | string? | |
| `expiredAt` | datetime? | VA 24h / DANA 30m / LINKAJA 5m / OVO/GOPAY/SHOPEEPAY 2m |
| `paidAt` | datetime? | |
| `logRequest` | Json? | |
| `logResponse` | Json? | |
| `createdAt`, `updatedAt` | datetime | |

Index: `(transactionId)`, `(status, expiredAt)`.

#### `commerce_payment_events` (`CommercePaymentEvent`)

Audit trail status change. Berguna untuk debugging Xendit re-delivery.

| Kolom | Tipe | Catatan |
|---|---|---|
| `id` | uuid v7 PK | |
| `paymentId` | uuid FK CommercePayment | |
| `source` | string | `checkout` \| `webhook` \| `poll` \| `manual` |
| `fromStatus` | enum? | |
| `toStatus` | enum | |
| `payload` | Json? | Raw webhook body / actor info |
| `createdAt` | datetime | |

Index: `(paymentId, createdAt)`.

#### `vouchers` (`Voucher`)

| Kolom | Tipe | Catatan |
|---|---|---|
| `id` | uuid v7 PK | |
| `legacyId` | int? unique | |
| `code` | string unique | |
| `productId` | uuid? FK Product | Null = global semua product |
| `type` | string | `PERCENT` \| `AMOUNT` |
| `value` | int | Percent (0-100) atau IDR |
| `maxAmount` | int? | Cap untuk PERCENT |
| `quota` | int? | Null = unlimited |
| `used` | int default 0 | Atomic increment saat success |
| `startsAt`, `endsAt` | datetime? | Window aktif |
| `isActive` | bool default true | |
| `createdAt`, `updatedAt` | datetime | |

#### Relation tambahan ke model existing

- `Member` → `transactions: CommerceTransaction[]`, `payments: CommercePayment[]`
- `Product` → `transactions: CommerceTransaction[]`, `vouchers: Voucher[]`
- `MemberAffiliator` → `transactions: CommerceTransaction[]`
- `AffiliateProgram` → `transactions: CommerceTransaction[]`
- `AffiliateCommission` — `paymentId` jadi FK eksplisit ke `CommercePayment` (sebelumnya raw uuid)

Migration name: `add_commerce_purchase_xendit`.

### Legacy mapping

| Legacy table | New table | Catatan |
|---|---|---|
| `commerce_pre_transaction` | `commerce_transactions` (PENDING) | Konsolidasi — preTx jadi transaction baru dengan status PENDING |
| `commerce_transaction` | `commerce_transactions` (PAID) | |
| `commerce_payment` | `commerce_payments` | |
| `commerce_transaction_detail` | _dropped_ | Single-product, line item = 1 |
| `commerce_transaction_shipping` | _dropped_ | No shipping |
| `voucher` | `vouchers` | |

---

## 3. API Flow

Semua endpoint member di `/api/member/...`. Webhook di `/api/webhook/...`.

### Endpoint catalog

| Method | Path | Module | Auth | Description |
|---|---|---|---|---|
| POST | `/api/member/product/checkout/submit` | commerce | bearer | Buat order PENDING, return transactionId + breakdown |
| POST | `/api/member/payment/commerce` | commerce | bearer | Charge via Xendit, return payment instructions |
| GET | `/api/member/payment/commerce/:transactionId` | commerce | bearer | Poll status (mobile waiting screen) |
| GET | `/api/member/payment/commerce/list` | commerce | bearer | History pagination |
| POST | `/api/member/payment/commerce/cancel` | commerce | bearer | Cancel PENDING transaction |
| POST | `/api/member/payment/voucher/validate` | commerce | bearer | Dry-run validasi voucher |
| POST | `/api/webhook/xendit/payment` | webhook | header-token | **Unified Xendit PaymentRequest callback** (VA / eWallet / CC). |
| POST | `/api/webhook/xendit/{va,ewallet,cc}` | webhook | header-token | Legacy aliases — same handler. Remove after Xendit dashboard URL switched. |

### Request / Response shapes

#### `POST /api/member/product/checkout/submit`

Request:
```json
{
  "productId": "uuid",
  "voucherCode": "EARLYBIRD"
}
```

Response:
```json
{
  "status": "success",
  "data": {
    "transactionId": "uuid",
    "transactionCode": "BB-20260513-0042",
    "itemTotal": 500000,
    "voucherAmount": 50000,
    "amount": 450000,
    "feePreview": {
      "cc": 12500,
      "va": { "BCA": 4000, "BNI": 4000, "MANDIRI": 4000, "BRI": 5500, "PERMATA": 4500 },
      "eWallet": { "OVO": 9900, "DANA": 6750, "LINKAJA": 6750, "GOPAY": 9000, "SHOPEEPAY": 9000 }
    },
    "expiredAt": "2026-05-14T08:30:00Z"
  }
}
```

#### `POST /api/member/payment/commerce`

Request (CC):
```json
{
  "transactionId": "uuid",
  "paymentType": "cc",
  "paymentMethodId": "pm-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```
`paymentMethodId` is a `pm-...` id issued by the Xendit Cards SDK on the mobile side (replaces legacy `cardTokenId + authenticationId` which were sunset with the v7 PaymentRequest migration).

Request (VA):
```json
{
  "transactionId": "uuid",
  "paymentType": "va",
  "bank": "BCA"
}
```

Request (eWallet):
```json
{
  "transactionId": "uuid",
  "paymentType": "eWallet",
  "ewalletType": "OVO",
  "ewalletPhone": "+628123456789"
}
```

Response (VA):
```json
{
  "status": "success",
  "data": {
    "paymentId": "uuid",
    "paymentStatus": "PENDING",
    "vaNumber": "8888812345678901",
    "bank": "BCA",
    "amount": 462000,
    "expiredAt": "2026-05-14T08:35:00Z"
  }
}
```

Response (CC immediate):
```json
{
  "status": "success",
  "data": {
    "paymentId": "uuid",
    "paymentStatus": "SUCCESS",
    "transactionStatus": "PAID"
  }
}
```

#### `GET /api/member/payment/commerce/:transactionId`

Response:
```json
{
  "status": "success",
  "data": {
    "transactionId": "uuid",
    "transactionCode": "BB-20260513-0042",
    "status": "PENDING",
    "amount": 462000,
    "activePayment": {
      "paymentId": "uuid",
      "paymentType": "va",
      "status": "PENDING",
      "vaNumber": "8888812345678901",
      "bank": "BCA",
      "expiredAt": "2026-05-14T08:35:00Z"
    },
    "product": { "id": "uuid", "title": "React Fundamentals", "thumbnail": "..." }
  }
}
```

#### `POST /api/webhook/xendit/payment` (unified)

Headers: `x-callback-token: $XENDIT_CALLBACK_TOKEN`

Body: Xendit `PaymentCallback` envelope (passthrough):
```json
{
  "event": "payment.succeeded",
  "business_id": "biz-abc-123",
  "created": "2026-05-18T08:30:00Z",
  "data": {
    "id": "py-...",
    "payment_request_id": "pr-...",
    "reference_id": "commerce-uuid",
    "status": "SUCCEEDED",
    "amount": 462000,
    "currency": "IDR",
    "payment_method": { "id": "pm-...", "type": "VIRTUAL_ACCOUNT" },
    "failure_code": null,
    "metadata": { "transactionId": "uuid", "memberId": "uuid" }
  }
}
```
Server lookup: `data.payment_request_id` (or `data.id` fallback) → `CommercePayment.xenditId`.

Response: `200 { "received": true }` (idempotent).

### Sequence — Happy path VA

```
Mobile                  Backend                   Xendit                    DB
  |                       |                         |                        |
  |--POST checkout/submit-->|                       |                        |
  |                       |--insert tx (PENDING)----|----------------------->|
  |                       |--resolve affiliator-----|                        |
  |<--{ transactionId } --|                         |                        |
  |                       |                         |                        |
  |--POST payment/commerce|                         |                        |
  | { type:va, bank:BCA } -->|                      |                        |
  |                       |--createCallbackVa------->|                        |
  |                       |<--{ vaNumber, vaId }----|                        |
  |                       |--insert payment(PENDING)|----------------------->|
  |                       |--insert event(checkout) |----------------------->|
  |<--{ vaNumber }--------|                         |                        |
  |                       |                         |                        |
  | (user transfer di m-banking)                    |                        |
  |                       |                         |<-bank confirms---------|
  |                       |<--POST webhook VA-------|                        |
  |                       |--verify token-----------|                        |
  |                       |--update payment(SUCCESS)|----------------------->|
  |                       |--update tx(PAID)--------|----------------------->|
  |                       |--insert event(webhook)--|----------------------->|
  |                       |--emit OnPaymentSuccess  |                        |
  |                       |   |-grant enrollment    |----------------------->|
  |                       |   |-affiliate commit    |----------------------->|
  |                       |   |-redeem voucher      |----------------------->|
  |                       |   `-notify mobile (push)|                        |
  |<--push notif----------|                         |                        |
  |                       |                         |                        |
  |--GET commerce/:tx---->|                         |                        |
  |<--{ status: PAID }----|                         |                        |
```

### Sequence — Voucher 100%

```
Mobile                  Backend                                              DB
  |                       |                                                   |
  |--POST checkout/submit |                                                   |
  | { voucher:FREE100 } ->|                                                   |
  |                       |--validate voucher (100% discount)                 |
  |                       |--insert tx(PENDING) amount=0 -------------------->|
  |<--{ tx, amount:0 }----|                                                   |
  |                       |                                                   |
  |--POST payment/commerce|                                                   |
  | { type:voucher } ---->|                                                   |
  |                       |--bypass Xendit                                    |
  |                       |--insert payment(SUCCESS) paymentType=voucher----->|
  |                       |--update tx(PAID) ------------------------------->|
  |                       |--emit OnPaymentSuccess                            |
  |                       |   `--redeem voucher (atomic used++) ------------>|
  |<--{ status:SUCCESS }--|                                                   |
```

### Sequence — Expired VA (cron)

```
Cron (every 5 min)        Backend                                            DB
  |                        |                                                  |
  |--tick------------------>|                                                 |
  |                        |--SELECT payments PENDING AND expiredAt < now---->|
  |                        |<--rows------------------------------------------|
  |                        |--update status=EXPIRED------------------------->|
  |                        |--update tx status=EXPIRED---------------------->|
  |                        |--insert event(poll, EXPIRED)------------------->|
  |                        |--emit OnPaymentExpired                           |
```

### Webhook idempotency rule

1. Verify `x-callback-token` header equals `env.XENDIT_CALLBACK_TOKEN` (timing-safe compare). Reject 401 jika mismatch.
2. Lookup `CommercePayment` via `xenditId = data.payment_request_id` (`pr-...`); fall back to `data.id` for redeliveries that omit the parent id. 200 noop jika tidak ada.
3. Jika `payment.status` sudah terminal (SUCCESS/EXPIRED/FAILED/CANCELED), return `200 {received:true, noop:true}` tanpa write.
4. Map `data.status` → internal via `mapPaymentRequestStatus` (`SUCCEEDED→SUCCESS`, `EXPIRED→EXPIRED`, `FAILED|VOIDED→FAILED`, `CANCELED→CANCELED`, else `PENDING`). Update `CommercePayment.status` + insert `CommercePaymentEvent` source=`webhook`.
5. Emit event sesuai status final.

Xendit re-delivers webhook hingga ada `200`. Step (3) memastikan re-delivery aman.

### Voucher redeem atomicity

```sql
UPDATE vouchers
SET used = used + 1
WHERE id = $1
  AND is_active = true
  AND (quota IS NULL OR used < quota)
  AND (starts_at IS NULL OR starts_at <= now())
  AND (ends_at IS NULL OR ends_at > now())
RETURNING id;
```

Jika `rowCount = 0` di listener → throw `VoucherExhaustedException`, payment success tetap commit (voucher gagal redeem ditangani via manual reconciliation).

---

## 4. Module Layout di Codebase

```
src/modules/commerce/
  commerce.module.ts
  commerce.routes.ts
  commerce.controller.ts
  checkout.service.ts
  payment.service.ts           // calls xenditGateway directly (SDK PaymentRequest)
  voucher.service.ts
  constants.ts                 // fee tables, expiry windows, status enums
  dto/
    start-checkout.dto.ts
    pay.dto.ts
    apply-voucher.dto.ts
  utils/
    generate-order-code.ts     // BB-{yyyymmdd}-{seq}
    compute-totals.ts          // pure
    compute-expiry.ts          // pure
    sanitize-va-name.ts        // VA customerName normalization

src/modules/webhook/
  webhook.module.ts
  webhook.routes.ts            // 1 primary + 3 legacy alias routes
  webhook.controller.ts
  xendit.handler.ts            // unified PaymentRequest callback
  xendit-callback.guard.ts     // verify x-callback-token
  dto/xendit-callback.dto.ts   // XenditPaymentCallbackDto

src/common/services/xendit.client.ts     // singleton `Xendit` SDK instance
src/common/services/xendit-gateway.ts    // XenditGateway port (createPaymentRequest, expirePaymentMethod)
src/common/services/xendit-signature.ts  // verifyXenditCallbackToken + generateExternalId
src/common/events/commerce-events.ts     // OnCommercePaymentSuccess/Expired/Failed
src/jobs/expire-pending-payments.ts      // 5-min cron
```

Wired:
- `src/core/register-modules.ts` ← register `CommerceModule`, `WebhookModule`.
- `src/modules/affiliate/affiliator.service.ts` ← add `commitCommissionsForPayment()`.
- `src/config/env.ts` ← add Xendit env vars.

---

## 5. Env Vars

| Var | Required | Default | Catatan |
|---|---|---|---|
| `XENDIT_SECRET_KEY` | yes | — | Server-side key (SDK auto-routes by key environment — `xnd_development_*` vs `xnd_production_*`). |
| `XENDIT_CALLBACK_TOKEN` | yes | — | Verify webhook header `x-callback-token`. |
| `XENDIT_EWALLET_SUCCESS_URL` | no | `brainboost://payment/result?status=success` | Mobile deeplink for eWallet AUTH redirect on success. |
| `XENDIT_EWALLET_FAILURE_URL` | no | `brainboost://payment/result?status=failure` | Mobile deeplink for eWallet AUTH redirect on failure. |
| `COMMERCE_VA_EXPIRY_HOURS` | no | `24` | |
| `COMMERCE_EWALLET_DANA_EXPIRY_MIN` | no | `30` | |
| `COMMERCE_EWALLET_LINKAJA_EXPIRY_MIN` | no | `5` | |
| `COMMERCE_EWALLET_DEFAULT_EXPIRY_MIN` | no | `2` | OVO / GOPAY / SHOPEEPAY |

`XENDIT_BASE_URL` removed — SDK manages its own base URL.

---

## 6. Phased Implementation

| Phase | Commit | Deliverable | Status |
|---|---|---|---|
| P1 | `f8611e1` | Schema + migration + env vars + `XenditService` skeleton + module skeleton | [x] |
| P2 | `36d7b90` | `startCheckout` + voucher validate + tests compute-totals/voucher/checkout | [x] |
| P3 | `839d3ec` | `createPayment` per type + XenditService HTTP via fetch + DI tests cc/va/ewallet | [x] |
| P4 | `e68a333` | Webhook routes + signature guard + idempotency + tests | [x] |
| P5 | `f025356` | `OnPaymentSuccess` listener (enrollment + commission + voucher redeem) + cron expire + tests | [x] |
| P6 | `8963666` | Swagger response DTOs + smoke routes + docs sync | [x] |
| P7 | _this commit_ | Migrate to `xendit-node@7` SDK (unified PaymentRequest); collapse webhooks to 1 route; rename `cardTokenId→paymentMethodId`, `xenditVaId→xenditPaymentMethodId` | [x] |

**Note (P7):** Previous attempt avoided the SDK because v7 dropped the legacy Card/VirtualAccount/EWallet classes. This phase commits to the SDK's unified `PaymentRequest` API as the standard. CC contract is now `paymentMethodId` (`pm-...`) from the Xendit Cards tokenizer on mobile — legacy `cardTokenId + authenticationId` removed. Webhook collapses to `/api/webhook/xendit/payment`; the `/va`, `/ewallet`, `/cc` aliases remain for one release as a transition buffer.

---

## 7. Verification Checklist

- [ ] `pnpm prisma:migrate` apply clean (rename migration `20260518100000_commerce_xendit_sdk_rename`)
- [ ] `pnpm prisma:generate` succeeds
- [ ] `pnpm test tests/commerce/` all green (payment-va/cc/ewallet, webhook, listener)
- [ ] `pnpm test tests/api-smoke.spec.ts tests/swagger-smoke.spec.ts` green
- [ ] Manual: Postman happy path **CC** with `paymentMethodId=pm-...` from mobile Cards SDK
- [ ] Manual: Postman happy path **VA** (BNI / MANDIRI) + Xendit "Simulate Payment" → webhook `/api/webhook/xendit/payment` → status PAID
- [ ] Manual: Postman happy path **eWallet** OVO sandbox → AUTH redirect URL present in response → simulate success in dashboard
- [ ] Manual: **VA retry** — second `/payment/commerce` call expires the previous `pm-...` (check dashboard)
- [ ] Manual: Voucher 100% bypass works (no SDK call)
- [ ] Manual: Cancel pending tx → `PaymentMethod.expirePaymentMethod` invoked
- [ ] Affiliate commission rows created post-success
- [ ] CourseEnrollment row created post-success
- [ ] Re-deliver webhook 5x → exactly one set of side effects (idempotent)
- [ ] Update Xendit dashboard webhook URL to `https://<host>/api/webhook/xendit/payment`
- [ ] `mcp__jcodemunch__index_file` run on every modified/new file

---

### Sandbox Limitations

**BCA VA (pre-P7).** Old legacy `/callback_virtual_accounts` rejected BCA in dev sandbox due to server-side substitution of a 2-char merchant name. P7 moves to `PaymentRequest` which accepts `customerName` via `virtualAccount.channelProperties.customerName` — verify the BCA path again on first SDK QA; the workaround may no longer be needed. Until confirmed, keep using **BNI / MANDIRI / BRI / PERMATA** for sandbox.

---

## 8. Parity Rules (must match legacy)

- VA expiry: +24 hours
- eWallet expiry: DANA 30m / LINKAJA 5m / OVO|GOPAY|SHOPEEPAY 2m
- Voucher 100% discount: bypass gateway, status SUCCESS langsung (legacy `$skipCharge = true`)
- Affiliate commission: see `CLAUDE.md` §5 (PERFORMANCE tier thresholds inclusive, GROWTH multitier L1=20 L2=10 L3=5 L4=5, early-stop di PERFORMANCE, INACTIVE=20%)
- Attribution: last-touch, 30-day cookie window (`COOKIE_DAYS = 30`)
- PENDING → BALANCE: commission moves 7 days after payment (`PENDING_TO_BALANCE_DAYS = 7`)
- `priceRecipient = floor(max(productPrice - voucherAmount, 0) * rate / 100)`
- Multi VA attempt: jika user retry, expire `PaymentMethod` aktif sebelumnya via `PaymentMethod.expirePaymentMethod(pm-...)` dulu, lalu buat PaymentRequest baru

---

## 9. Out of Scope (Backlog)

- IAP (Apple/Google) — defer ke `subscription` module nanti
- Cart (multi-item) — defer kalau ada physical product
- Shipping / courier / area lookup
- `TBBalance::history` ledger entry
- `TBFacebook::purchaseCallback` server-side pixel
- `TBCustomer` CRM tagging
- Email templates (`CommerceTransaction` / `CommerceTransactionChief`)
- Push notif templates (`UpdateTransactionCommerce` / `TransactionCommerceChief`)
- Refund flow (cancel exists tanpa refund Xendit di MVP)
- Per-product fee override
- Multi-payment (split bill)
- Apple/Google subscription renewal

---

## 10. Open Gaps Before Implementation

- [ ] Locate Xendit fee table per channel — verify current values match the SDK pricing on staging account
- [ ] Decide order code format (`BB-YYYYMMDD-####`) — sequence per day vs global
- [ ] Confirm `CourseEnrollment` unique constraint `(memberId, courseId)` exists; add migration kalau belum
- [ ] Confirm affiliate `commitCommissionsForPayment()` interface dengan existing `walkInviterChain` util
- [ ] Mobile coordination: switch CC tokenization to the Xendit Cards SDK that emits `pm-...` ids (replaces legacy `cardTokenId + authenticationId`)
- [ ] After sandbox QA confirms PaymentRequest VA accepts BCA, drop the BNI/MANDIRI-only note in §7
