# Public Checkout Quote — BE ↔ FE Contract

Companion to `docs/checkout-tax-contract.md` (§3.2, the authed quote).

- **Status: built 2026-10-01** on `feat/public-checkout-quote` (not merged, not
  on stage yet).
- **Purpose:** a visitor who has not logged in sees the real price of a course —
  voucher applied, PPN included — before being asked to log in. Same numbers
  the authed quote returns; nothing is created.

---

## 1. Endpoint

### `POST /api/member/product/checkout/quote/public` — NEW

- **Auth: none.** Do not send a bearer. If one is attached anyway (expired,
  malformed, valid) it is ignored: this route never answers `401` and never
  changes its answer because of who is logged in.
- **Rate limited per IP** — 20 requests / 15 minutes, the same budget as
  `/payment/voucher/validate`. Over budget → `429`. Call it on page open and
  when the visitor submits a voucher code; do not call it per keystroke.
- **Writes nothing:** no transaction, no order number, no voucher reservation.

Request:

| Field | Type | Required |
|---|---|---|
| `productId` | string (uuid) | yes |
| `voucherCode` | string | no |

Response `data` — identical to the authed quote:

| Field | Type | |
|---|---|---|
| `itemTotal` | number | catalog price, pre-tax |
| `voucherAmount` | number | `0` without a voucher |
| `taxRate` | number | percent, e.g. `11`; `0` while tax is off |
| `taxAmount` | number | on `itemTotal − voucherAmount` |
| `amount` | number | tax-inclusive total, the number to show |

```json
{
  "success": true,
  "data": {
    "itemTotal": 298000,
    "voucherAmount": 50000,
    "taxRate": 11,
    "taxAmount": 27280,
    "amount": 275280
  },
  "meta": null,
  "error": null
}
```

Arithmetic and rounding: `docs/checkout-tax-contract.md` §1. FE does not
recompute any of it.

---

## 2. Errors

| Status | `error.code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `productId` missing or not a uuid |
| 404 | `PRODUCT_NOT_FOUND` | no such product |
| 400 | `PRODUCT_NOT_AVAILABLE` | product inactive / unpublished |
| 400 | `VOUCHER_INVALID` | voucher cannot be used — `error.details.reason` holds the visitor-facing Indonesian copy |
| 429 | — | rate limit |

Product errors are the same codes the authed quote returns. There is no
`PRODUCT_ALREADY_PURCHASED` here (see §4a).

```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "VOUCHER_INVALID",
    "message": "Voucher tidak dapat digunakan",
    "details": { "reason": "Voucher sudah kedaluwarsa" }
  }
}
```

Show `details.reason` under the voucher field. To show the price without the
voucher, call again without `voucherCode`.

---

## 3. Guest voucher rules

| Voucher | Answer |
|---|---|
| Public code, usable on this product | 200, discount applied |
| Unknown code | 400, reason `Voucher tidak ditemukan` |
| Inactive / not started / expired / quota used up / not valid for this product | 400, a specific reason — same wording as the authed quote |
| **Private code** (issued to one member, or belonging to a campaign such as the first-purchase voucher) | 400, **byte-for-byte the unknown-code answer** |
| **Free-trial code** | 400, reason `Masuk dulu untuk memakai voucher uji coba ini`, no price |

- A private code looks like a code that does not exist, in every state it can
  be in. That is deliberate: this endpoint is public, and any other answer
  would confirm to a stranger that the code is real. Its owner sees the
  discount after login, from the authed quote. FE must not special-case it —
  there is nothing to detect.
- A free trial is once per member, so there is no honest price for a visitor
  we cannot identify. Treat that reason as a login prompt: send the visitor to
  login and re-quote with the authed endpoint.

---

## 4. Notes

**(a) It is an estimate.** The number is what a *new* buyer pays. After login
the authed `POST /api/member/product/checkout/quote` is authoritative and can
still refuse what the public quote accepted:

- `PRODUCT_ALREADY_PURCHASED` — the member already owns the course;
- `VOUCHER_TRIAL_ALREADY_USED`, `VOUCHER_COURSE_ONLY`, … — per-member voucher
  rules.

It can also accept what the public quote refused (a private or trial code, for
its owner). So: after login, always re-quote with the authed endpoint before
rendering the checkout summary, and never carry the public numbers into
submit. For the same product and a public voucher the two return identical
bodies.

**(b) `promoPrice` is before PPN.** `GET /api/member/promo/public` returns
`promoPrice = itemTotal − voucherAmount`, with no tax. To show the
PPN-inclusive total on the promo or product page, call this endpoint with the
promo's `voucherCode` and render `amount` (and the tax row when
`taxAmount > 0`). While tax is off, `amount === promoPrice`.

Event tickets are out of scope: they have their own public
`GET /api/event/quote` and are not taxed.
