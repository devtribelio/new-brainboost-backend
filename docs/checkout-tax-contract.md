# Checkout Tax (PPN) — BE ↔ FE Contract

BE's answer to the FE proposal `checkout-tax-contract.md` (FE, 2026-09-28).
This is the contract FE builds against. Where it differs from the proposal,
this document wins and the difference is called out.

Backend analysis + rationale: `docs/checkout-tax.md`.
Companion: `docs/event-ticketing-contract.md` (§2b quote, §3 checkout, §4 order).

- **Status: built 2026-09-29** on `feat/checkout-tax` (not merged, not on
  stage yet). Ships with the rate at `0`, so nothing changes for buyers until
  it is flipped. No release date yet.
- **Scope: course checkout + event tickets + transaction history.**
  Subscription is OUT of scope — `feat/subscription` is not on `main`, so
  `prorationCredit` does not exist in any response below.
- **Event tickets are NOT taxed** (decided 2026-09-30). The event endpoints
  still carry `taxRate`/`taxAmount` for shape parity, and they are always `0`
  for a ticket order, so the tax row never renders there. See §5.

---

## 1. The rule (unchanged from the proposal)

```
taxBase   = itemTotal − voucherAmount            (never below 0)
taxAmount = round(taxBase × taxRate / 100)       (half-up, whole rupiah)
amount    = taxBase + taxAmount                  (tax-inclusive)
```

- `itemTotal` and `voucherAmount` keep their exact current meaning. A PERCENT
  voucher is still `floor(itemTotal × pct / 100)` capped by `maxAmount`,
  computed on the pre-tax price.
- `amount` is the single billable number: Xendit invoice, every total on
  screen. It is **now tax-inclusive**.
- `taxRate` is a percent (`11` = 11 %), backend config, returned only for the
  label. FE never sends it, never assumes it.
- Rounding: `Math.round` on a non-negative number = round half up. FE does
  not reimplement it; it is documented for QA only.
- **All amounts are `number`, everywhere.** The proposal said the submit
  response returns strings — it does not, and never did. One type across
  every endpoint.

| Case | Result |
|---|---|
| No voucher | `taxBase = itemTotal` |
| 50 % voucher | tax on the discounted price |
| 100 % AMOUNT / PERCENT voucher | `taxAmount = 0`, `amount = 0`, zero-amount settlement unchanged (empty `invoiceUrl`, order PAID) |
| TRIAL voucher | same as 100 %; `trialDays` unchanged |
| Event, qty N with package ladder | tax on the ladder total, one tax line, `breakdown` stays pre-tax |
| Order created before this change | `taxRate = 0`, `taxAmount = 0`, `amount` unchanged |

---

## 2. Ground rules

- Every change is **additive**. No request body changes. No field is renamed
  or removed. Only `amount` changes meaning (tax-inclusive).
- FE reads `taxAmount ?? 0` and `taxRate ?? 0` so either side can deploy first.
- BE ships with the rate at **0** → nothing changes for buyers until the rate
  is flipped in config (no redeploy). Rows render only when `taxAmount > 0`.
- Catalog prices (`product/list`, `product/course/detail`, event `/on-sale`
  and `/:slug`) stay pre-tax and are **not touched**. If legal wants "Harga
  belum termasuk PPN", that copy belongs on the **event page too**, not only
  the product page.

---

## 3. Endpoints

### 3.1 `POST /api/member/product/checkout/submit` — changed

Request: unchanged.

`data`:

| Field | Type | |
|---|---|---|
| `transactionId` | string | unchanged |
| `transactionCode` | string | unchanged |
| `itemTotal` | number | unchanged, pre-tax |
| `voucherAmount` | number | unchanged |
| `taxRate` | number | **NEW** — percent, e.g. `11` |
| `taxAmount` | number | **NEW** |
| `amount` | number | **now tax-inclusive** |
| `expiredAt` | string (ISO) | unchanged |

No `prorationCredit` (see scope).

### 3.2 `POST /api/member/product/checkout/quote` — NEW

Prices a course checkout without creating anything: no transaction, no order
number, no voucher reservation. Replaces the client-side discount estimate in
the summary card. Call it on product open and on every voucher-code change.

- Auth: bearer (member). Rate-limited like `/payment/voucher/validate`, for
  the same reason (a live-code oracle otherwise).
- Request:

  | Field | Type | Required |
  |---|---|---|
  | `productId` | string | yes |
  | `voucherCode` | string | no |

- Response `data`: same as 3.1 **minus** `transactionId`, `transactionCode`,
  `expiredAt`.
- **Invalid voucher → the same 400 as submit** (`error.code` =
  `VOUCHER_INVALID` / `VOUCHER_TRIAL_ALREADY_USED` / `VOUCHER_COURSE_ONLY` /
  …, `error.details.reason` = member-facing Indonesian copy). Not the
  `voucher` sub-object variant. One code path; FE already handles these on
  submit. To show the price without the voucher, call again without
  `voucherCode`.
- Product already owned → 400 `PRODUCT_ALREADY_PURCHASED`, same as submit, so
  the card never shows a price that submit is guaranteed to refuse.

### 3.3 `POST /api/member/payment/voucher/validate` — unchanged

3.2 ships in the same release, so the fallback in the proposal (§2.3) is not
built. Nothing added here.

### 3.4 `GET /api/event/quote?ticketTypeId=&qty=` — changed ⚠️ pending

| Field | Type | |
|---|---|---|
| `qty` | number | unchanged |
| `itemTotal` | number | unchanged, ladder total, pre-tax |
| `breakdown` | array | unchanged, pre-tax lines |
| `taxRate` | number | **NEW** |
| `taxAmount` | number | **NEW** — on `itemTotal` (no voucher here) |
| `amount` | number | **NEW** — `itemTotal + taxAmount` |

Public endpoint, so the rate is visible to anyone. Accepted.

### 3.5 `POST /api/event/checkout` — changed ⚠️ pending

Request: unchanged.

`data`: + `taxRate`, `taxAmount`; `amount` now tax-inclusive
(`itemTotal − voucherAmount + taxAmount`). `breakdown`, `payment`, `tickets`
unchanged.

### 3.6 `GET /api/event/order/:code` — changed ⚠️ pending

`data`: + `taxRate`, `taxAmount` beside the existing `amount`, so the order
page can show the same summary card as checkout. Credentials rule unchanged
(bearer / `t` / `email`, any one).

### 3.7 `GET /api/member/payment/commerce/list` — changed

Each row: + `taxRate`, `taxAmount`. `feeTotal` stays the gateway fee (today
always `0`); tax is **not** folded into it. Old orders carry `0` in both.

### 3.8 `GET /api/member/payment/commerce/:transactionId` — changed

`data`: + `itemTotal`, `voucherAmount`, `taxRate`, `taxAmount` beside the
existing `amount` (today detail returns `amount` only). Old orders: tax
fields `0`, the rest as stored.

### 3.9 `POST /api/member/payment/commerce` — unchanged

No new fields. The Xendit invoice is created for the tax-inclusive `amount`.
`fee` in the response stays `0`.

---

## 4. Answers to the proposal's open questions

| # | Question | Answer |
|---|---|---|
| 1 | Rate + rounding | Rate lives in backend config (`app_settings`), ships at `0`. Round half up to whole rupiah. Note the current Indonesian regime is a nominal 12 % on an 11/12 base = effective 11 %; the returned `taxRate` is the effective percent to print. |
| 2 | Payment fee in the base? | Outside. No buyer-borne gateway fee exists today (`fee` is always `0`). |
| 3 | Affiliate commission base | **Decided + built:** pre-tax (`amount − taxAmount`). An affiliator earns the same on a course whatever the rate. Not FE-visible. |
| 4 | Course quote endpoint | Yes, same release (§3.2). |
| 5 | Old orders | `taxAmount: 0`, `taxRate: 0`, fields always present. No backfill. |
| 6 | Per-product exemptions | One: `event_ticket` products resolve `taxRate = 0` (§5). FE logic is identical — the row hides on `taxAmount = 0`. |
| 7 | Invoice / receipt lines | Xendit invoice page: no breakdown for now (deferred). Email receipts (bb-comms) **will** show the PPN line — that repo is in the release train. |

---

## 5. Event tickets — NOT taxed (decided 2026-09-30)

The proposal assumed event tickets are taxed like courses (§2.5–2.7, QA
T-07/T-08). **They are not.** BE resolves `taxRate = 0` for any `event_ticket`
product regardless of the configured rate, so on every event endpoint
`taxRate` and `taxAmount` are always `0` and `amount === itemTotal −
voucherAmount`.

What this means for FE:

- Build the event screens against §3.4–3.6 as written; the fields exist for
  shape parity and read `0`. The tax row therefore never shows on an event.
- Do **not** put the "Harga belum termasuk PPN" copy on event pages.
- QA T-07 / T-08 change meaning: assert `taxAmount = 0` and no tax row on a
  ticket order **while** a course order in the same environment shows PPN.

No open decisions remain on the BE side.

---

## 6. Rollout

1. BE: migration (2 columns, default 0) + bb-comms reads them.
2. BE: all fields above, rate `0`. FE verifies field presence on stage.
3. FE: new rows + types, hidden while `taxAmount = 0`.
4. BE flips the rate on stage → QA T-01…T-12 → prod.

### QA cases (BE-relevant, subscription removed)

| # | Flow | Setup | Expect |
|---|---|---|---|
| T-01 | Course | no voucher | tax = round(price × rate), total = price + tax |
| T-02 | Course | 50 % voucher | tax on half price |
| T-03 | Course | AMOUNT voucher ≥ price | tax 0, total 0, PAID without invoice |
| T-04 | Course | TRIAL voucher | tax 0, total 0, trial days shown |
| T-07 | Event | qty 5 with ladder, rate 11 % | `taxAmount = 0`, no tax row, `amount = itemTotal`, breakdown unchanged |
| T-08 | Event | guest checkout, rate 11 % | order page shows no tax row; a course bought in the same env does |
| T-09 | History | pre-change order | no tax row, total unchanged |
| T-10 | Any | Xendit invoice | equals tax-inclusive `amount` on the card |
| T-11 | Any | product page, ticket list | price unchanged, no tax anywhere |
| T-12 | Course | quote → submit, same voucher | identical `taxAmount` / `amount` in both responses |
