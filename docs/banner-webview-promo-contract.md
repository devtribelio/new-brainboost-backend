# Banner Webview + Promo Landing — BE Response to the FE Contract

Reply to the FE draft "Banner Webview + Promo Landing — Draft API Contract" (v2,
2026-10-01, Lionnarta). The contract is accepted as written; this page lists what
was built, the answers to its open questions, and the few places where the real
response differs from the draft.

- **Status:** live on staging since 2026-10-01 (`https://be-bb-staging.brainboostos.com`). Not in production yet.
- **Backend PR:** devtribelio/new-brainboost-backend #210 (merged)
- **Backoffice PR:** adhitia/backoffice-bb #45 (merged)
- **Internal spec:** `docs/promo-landing.md`

## What FE can rely on today

| Item | State |
| --- | --- |
| Field names and response shapes in §1 and §2 of the draft | Final. |
| Real endpoints on staging | Live. Switch from the mock to the real endpoints. |
| Sample promos on staging | Two are running (see "Staging data"). |
| A `webview` banner on staging | To be created by ops; BE will share it. |

---

## §1 Banner `openMode` — `GET /api/member/data/banner`

Built as proposed. One additive field per banner; request, paging and the version
gate are unchanged.

```jsonc
{
  "id": 123,                       // number (legacy id) when the banner has one, else a UUID string
  "client": "brainboost",
  "link": "https://shop.brainboost.id/promo/oktober",
  "image": ["https://.../banner.png"],
  "isPopup": true,
  "startedAt": null,
  "endedAt": null,
  "openMode": "webview"            // NEW: "external" | "webview"
}
```

**Answers**

1. **Naming:** `openMode` with `external` / `webview` is used exactly as proposed.
2. **Existing banners:** every existing banner returns `openMode: "external"`. The
   field is always present and never `null`. Nothing changes until someone opts a
   banner in from the backoffice.
3. **Staging:** see "What FE can rely on today".

**Difference from the draft**

- The draft says "all ids as strings". A banner `id` is a **number** when the
  banner has a legacy id, and a UUID string otherwise. This is the existing
  behaviour and is not changed by this work.

BE does not validate `link` against `openMode`; the app applies its own rules, as
the draft describes.

---

## §2 Promo landing — `GET /api/member/promo/public`

Built as proposed: no parameters, auth optional, returns every active promo with
its products. An empty `data: []` is a normal answer.

```jsonc
{
  "success": true,
  "data": [
    {
      "slug": "oktober",
      "title": "Promo Oktober BrainBoost",
      "subtitle": "Harga khusus sampai 15 Oktober.",   // nullable
      "voucherCode": "OKTOBER30",                      // always present, see below
      "endsAt": "2026-10-15T23:59:59+07:00",           // nullable
      "products": [
        {
          // every field of a `product/list/public` item, produced by the same code
          "price": 298000,
          "isPurchased": false,
          // …
          "promoPrice": 208600                         // NEW
        }
      ]
    }
  ]
}
```

**Field notes**

| Field | What BE returns |
| --- | --- |
| `slug` | Lowercase letters, digits and hyphens. Unique across all promos, not only the active ones. |
| `voucherCode` | **Never `null`.** Every promo has exactly one voucher. Keep appending `?voucher={code}` to that promo's product links. |
| `endsAt` | The earlier of the promo's end and its voucher's end; `null` when neither has one. ISO-8601 with `+07:00`. |
| `products` | In the order set in the backoffice. Same item shape as the catalog list, plus `promoPrice`. With a token, the item also carries the same commission preview fields the catalog returns. |
| `products[].price` | Normal price, before PPN. |
| `products[].promoPrice` | Price with the promo's voucher applied, **before PPN**. PPN is switched on, so the buyer pays more than this; see "PPN" below. |
| Order of promos | Set by a position field in the backoffice. FE only moves the URL's promo to the top. |

**Answers to the open questions**

1. **Is a promo a record?** Yes, now: a promo is slug + title + subtitle + one
   voucher + an ordered list of products. It is created in the backoffice.
2. **Same pricing as the quote?** Yes. `promoPrice` is computed by the same
   function that prices checkout, including the PERCENT floor and cap. For any
   product, `promoPrice` equals `itemTotal − voucherAmount` from
   `POST /api/member/product/checkout/quote` with that `voucherCode`. An automated
   test asserts this against the real quote endpoint.
3. **Tax:** confirmed. `price` and `promoPrice` are both before PPN, the same basis
   as the catalog. See "PPN" below for what that means on the page.
4. **A product in two active promos:** forbidden. The backoffice refuses to save or
   activate a promo that shares a product with another active promo in an
   overlapping period. The API itself does not de-duplicate, so keep the "show it
   once" handling as a safety net.
5. **Voucher runs out mid-promo:** the promo drops out of the list. The same
   happens when the voucher is deactivated or expires, or when the promo itself is
   deactivated or its period ends. FE never receives a promo whose price checkout
   would refuse.
6. **Products the member owns:** kept in `products` with `isPurchased: true`.
7. **Rate limiting:** none, the same as `product/list/public`.

**Also worth knowing**

- A product is left out of a promo when it is not in the public catalog (inactive
  or a non-listable type) or when the promo's voucher does not cover it. A promo
  left with no products is not returned at all.
- Only public discount vouchers (`PERCENT` or `AMOUNT`) can back a promo. A trial
  voucher or a member-owned code never appears here.
- A slug that is unknown, not started, or ended is simply absent from the list, so
  the single "not found or ended" message in the draft is the right handling.
- The slug can be edited in the backoffice after creation (decided: it is not
  locked). Changing it breaks links already shared; BE keeps no history of old
  slugs, so an old link shows the "not found or ended" message.

**PPN**

PPN is switched on (`tax.enabled`). `price` and `promoPrice` do not include it, so
the amount charged at checkout is `promoPrice` plus PPN, as returned by
`POST /api/member/product/checkout/quote` (`taxRate`, `taxAmount`, `amount`). The
promo page should treat prices exactly as the catalog and product pages already
do: either label them as before PPN, or leave the total to the checkout summary.
The "Hemat N%" badge is unaffected, since both prices are on the same basis.

---

## §3 Which link goes on a banner

No BE involvement, as the draft says. The backoffice banner form now has the
`openMode` select ("Buka di browser" / "Buka di dalam aplikasi"), and the promo
list shows each promo's public link with a copy button, so marketing pastes the
public link and never types `/webview/`.

---

## §4 Rollout

| Step | Owner | State |
| --- | --- | --- |
| 1. `openMode` on the banner response | BE | On staging |
| 2. Active promos endpoint | BE | On staging |
| 2a. Backoffice: banner select + promo page | BE | On staging |
| 2b. Deploy to staging (backend first, then backoffice) | BE | Done 2026-10-01 |
| 2c. Web switches from the mock to the real endpoint | FE | Can start now |
| 3. Marketplace release with the promo page | FE | |
| 4. App 3.3.4 release | FE | |
| 5. Create the promo and the `webview` banner in production | Ops | After 3 and 4 |

Backend must be deployed before the backoffice in every environment: the backoffice
banner list reads the new column.

## Staging data

Two promos are running on staging, both on PERCENT vouchers, three courses each
(normal price 298,000):

| Slug | Voucher code | `promoPrice` | Ends |
| --- | --- | --- | --- |
| `oktober-1` | `OKTOBERPROMO1` | 268,200 | 2026-10-10 16:23 WIB |
| `oktober2` | `OKTOBERVC1` | 253,300 | 2026-10-12 16:24 WIB |

Public pages: `https://stag-marketplace.brainboostos.com/promo/oktober-1` and
`…/promo/oktober2`.

Still to come from BE/ops:

- one banner with `openMode: "webview"` linking to one of the pages above;
- a promo on an AMOUNT voucher;
- a test account that already owns one of the promo products (for the "Dimiliki" case).

## What BE needs back from FE

- Confirmation that an always-present `voucherCode` and a numeric banner `id` cause
  no problem on either client.
- How the promo page presents prices now that PPN is on (see "PPN").
