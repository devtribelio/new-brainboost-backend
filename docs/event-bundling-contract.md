# Event ticket bundles — FE contract

Delta note for the marketplace FE. The endpoints live in
`docs/event-ticketing-contract.md` (§2, §2b, §3); this is what changed and why the
price on screen can disagree with the bill.

- **Written:** 2026-09-11
- **Status:** on the backend, not deployed
- **Breaks one thing on purpose:** `itemTotal` no longer means `price × qty`

---

## 1. The bug this exists to fix

Observed on `founders-summit-2026` — ticket kind "Single", unit `20000`, with a
"Duo Combo" package at `35000`:

| | |
|---|---|
| Xendit charged | **35 000** |
| The shop displayed | **40 000** (`20000 × 2`) |

The backend was right. The page was multiplying in the client, and with a package
ladder that multiplication is no longer the price.

---

## 2. Two sources. They do different jobs — you need both

### `priceTiers` — for DISPLAY

Already on every ticket kind in `GET /api/event/:slug`:

```jsonc
{
  "id": "0199c3a1-....",
  "name": "Single",
  "price": 20000,                 // UNIT price — render as "mulai Rp20.000"
  "priceTiers": [                 // [] = no packages, behave exactly as before
    { "minQty": 2, "totalPrice": 35000, "label": "Duo Combo" },
    { "minQty": 3, "totalPrice": 50000, "label": "Triple Combo" }
  ],
  "maxPerOrder": 5
}
```

Use it to show what is on offer — "Duo Combo Rp35.000 · Triple Combo Rp50.000" — and
to label the quick-pick buttons. `label` may be `null`; fall back to `Paket <minQty>`.

### `GET /api/event/quote` — for the PRICE

```
GET /api/event/quote?ticketTypeId=<uuid>&qty=2
```

```jsonc
{
  "qty": 2,
  "itemTotal": 35000,
  "breakdown": [ { "label": "Duo Combo", "qty": 2, "amount": 35000 } ],
  "voucherAmount": 0,
  "amount": 35000
}
```

Public, no `Authorization`. Writes nothing, reserves nothing. Call it on every change
of the quantity and render the summary from `breakdown`.

---

## 3. Do not price this in the client. Here is why, in your own numbers

The backend always charges the **cheapest** combination for a quantity. That is not a
multiplication, and it is not "use the biggest package, then singles" either:

| qty | What the backend bills | Biggest-package-first would bill |
|---|---|---|
| 1 | 20 000 | 20 000 |
| 2 | **35 000** (Duo) | 35 000 |
| 3 | **50 000** (Triple) | 50 000 |
| 4 | **70 000** (Triple + 1) | 70 000 |
| 5 | **85 000** (Triple + Duo) | 90 000 ❌ |

At qty 5 the obvious client-side algorithm overcharges by 5 000. Finding the real
minimum is a search, not arithmetic — the backend runs one. A second implementation in
the client will diverge, and the wrong number is always the one the buyer sees.

So: **no price arithmetic in the client at all.** Not `price × qty`, not
`tier.totalPrice + leftover × price`. Ask `/quote`.

---

## 4. `itemTotal` changed meaning

`POST /api/event/checkout` keeps its **request** shape (quantity is still the length of
`attendees`). Its response:

- **`itemTotal` is the total after the ladder**, no longer `price × qty`. Any comment
  or type in the FE that says otherwise is now wrong.
- **`breakdown` is new** and has the same shape as `/quote`, so the checkout summary
  and the success page can share one component.
- `voucherAmount` / `amount` are unchanged in meaning. A PERCENT voucher now discounts
  the **bundled** total — 10 % off a Duo is 3 500, not 4 000.

---

## 5. What to build

1. **Ticket card** — `price` as "mulai Rp20.000", plus the package list from
   `priceTiers`. No separate card per package; it is one ticket kind.
2. **Quantity picker** — quick buttons from the ladder (Solo = 1, Duo = 2,
   Triple = 3) **and** a ±1 stepper. Picking Triple then pressing + gives 4, and the
   summary reloads. Cap it at `maxPerOrder` (5 on this kind).
3. **Price summary** — rendered from `breakdown`, e.g. "Triple Combo Rp50.000 + 1
   satuan Rp20.000". Debounce `/quote` ~300 ms so a stepper held down sends one call.
4. **Success page** — read `itemTotal` + `breakdown` from the checkout response.
5. **Delete every price multiplication.**

If `priceTiers` is `[]`, the whole feature is invisible: `/quote` still answers
`price × qty`, so you can route all pricing through it unconditionally and keep one
code path.

**Minimum fix if the full picker cannot ship yet:** call `/quote` for the summary line
alone, skip the package cards. One request, one number replaced, and the figure in
front of buyers stops being wrong.

---

## 6. Edges worth knowing

- **No voucher on `/quote`.** It takes no `voucherCode` and always reports
  `voucherAmount: 0`. Voucher validation is per-member (a trial code is once per
  account) and sits behind auth, so accepting codes on a public endpoint would confirm
  which codes are live. Show the discount at checkout.
- **`/quote` does not check seats.** `qty` above `maxPerOrder` is
  `400 EVENT_TICKET_QTY_INVALID`; availability is not verified, because quoting is not
  buying. Gate the stepper on `remainingQuota` from §2, and treat a checkout that
  refuses with `EVENT_TICKET_SOLD_OUT` as the final word.
- **Unknown `ticketTypeId`** → `404`.
- **`lowestPrice` on `/api/event/on-sale` is still the unit price.** Correct for a
  "mulai dari" badge on the swiper; never a total.
- **A package eats its seats.** Duo takes 2 of the quota and asks for 2 attendee
  name + email blocks. Nothing about the attendee form changes.
- **`label` is copy, not a key.** Do not switch on it, do not translate it — it comes
  from the backoffice verbatim, like the ticket kind's name.

---

## 7. Checklist

- [ ] render `priceTiers` on the ticket card
- [ ] route every total through `/quote`, debounced
- [ ] render the summary from `breakdown`, at checkout and on success
- [ ] cap the picker at `maxPerOrder`
- [ ] grep the FE for `* qty` / `* quantity` on any price and delete it
- [ ] fix any type or comment still claiming `itemTotal` is `price × qty`
