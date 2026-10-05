# Promo landing + banner `openMode`

Backend side of the FE contract "Banner Webview + Promo Landing" (2026-10-01).
Migration `20261001120000_banner_open_mode_promo`. Authoring UI lives in **backoffice-bb**.

## 1. Banner `openMode`

`banners.open_mode TEXT NOT NULL DEFAULT 'external'`, returned as `openMode` by
`GET /api/member/data/banner`. Values in use: `external` (system browser) and
`webview` (in-app browser). No CHECK and no validation against `link`: the app
treats any value it does not know as `external` and applies its own link rules.
Every existing banner comes back `external`, so nothing changes until ops opts one in.

Banner `id` is the legacy int when the row has one (`legacyId ?? id`), a UUID string
otherwise. It is not always a string.

## 2. `GET /api/member/promo/public`

Module `apps/mobile-api/src/modules/promo/`. Optional auth, no parameters, no rate
limiter (same as `product/list/public`). Returns every promo running now:

```
[{ slug, title, subtitle, voucherCode, endsAt, products: [<catalog item> + promoPrice] }]
```

### Tables

| `promos` | |
|---|---|
| `id` | uuid pk |
| `slug` | text, unique |
| `title`, `subtitle` | text, subtitle nullable |
| `voucher_id` | uuid, FK `vouchers` (RESTRICT) |
| `position` | int, default 0 |
| `is_active` | bool, default true |
| `starts_at`, `ends_at` | timestamp (UTC, tz-less), nullable = open |
| `created_at`, `updated_at` | timestamp |

| `promo_products` | |
|---|---|
| `promo_id` | FK `promos`, cascade |
| `product_id` | FK `products`, cascade |
| `position` | int, default 0 |
| pk | `(promo_id, product_id)` |

A promo is slug + title + ONE voucher + an ordered product list. It stores no price.
A plain-SQL writer must supply `id` and `updated_at` itself: both defaults are
Prisma-Client-side, not Postgres defaults.

### Listing rules

A promo is listed only when all of these hold; otherwise it is absent:

- promo `is_active`, and now is inside `starts_at`/`ends_at` (null = open);
- its voucher is `is_active`, inside its own window, and `quota IS NULL OR used < quota`;
- voucher `type` is `PERCENT` or `AMOUNT` (never `TRIAL`);
- voucher `owner_member_id` and `campaign` are both NULL, so a member-owned or
  program-issued code can never leak through a public endpoint;
- at least one product is left after the product filter.

Products come from `promo_products` by `position`, keeping only those that would
appear in the public catalog (`is_active`, type in `LISTABLE_PRODUCT_TYPES`) and that
the voucher covers (zero `voucher_products` rows = global, otherwise the product must
be listed). Promos are ordered `position ASC, created_at DESC`.

`promoPrice` = `computeTotals({ unitPrice: price, qty: 1, voucher, taxRate: 0 }).amount`.
That is the function `CheckoutService.price()` runs, so floor, cap (`max_amount`) and
the clamp at the price are the same on the card and on the bill. The spec asserts
`promoPrice == quote.itemTotal - quote.voucherAmount`.

`endsAt` = the earlier of promo and voucher `ends_at`, formatted in WIB with an
explicit `+07:00` offset; null when both are null.

Each product item is `serializeProduct` output (the `product/list/public` shape,
including rating, `isPurchased` and the commission preview) plus `promoPrice`.

### Answers to the contract's open questions

1. A promo is its own record (`promos`), backed by one voucher and a product list.
2. Yes, `promoPrice` reuses the checkout arithmetic (`computeTotals`).
3. `price` and `promoPrice` are both before PPN. Tax is added only at checkout.
4. One product in two active promos is forbidden at authoring time in the
   backoffice. The API does not enforce it; if it happens the product appears in both.
5. A voucher whose quota runs out makes the promo drop out of the list.
6. Owned products stay in `products` with `isPurchased: true`.
7. No rate limiter, same as `product/list/public`.

`voucherCode` is never null today: every promo has a voucher.

### Version gate (mobile only)

To run a promo on prod where only an unreleased internal build sees it. Global, not per
promo: four `app_settings` rows, seeded empty (= off), cached ~30s, so an SQL edit lands
with no redeploy.

| key | meaning |
|---|---|
| `promo.minVersionAndroid` / `promo.maxVersionAndroid` | Android window, both INCLUSIVE, empty = unbounded |
| `promo.minVersionIos` / `promo.maxVersionIos` | iOS window, same rules |

The caller sends `?platform=android|ios&version=3.3.2` (same params as `/data/banner`).
The caller is the marketplace promo page, not the app: the app appends both to the
webview URL and the page forwards them. FE contract: `docs/promo-version-gate-contract.md`.

- No `platform`, or one that is not `android`/`ios` = the web shop: **never gated**.
- Mobile with a bound set: listed only when `min <= version <= max` (numeric semver).
  A missing or unparseable `version` gets `[]` — fail CLOSED, the opposite of the banner
  gate, because hiding from builds we cannot place is the point, and no build older than
  this endpoint calls it.
- Hidden = the whole list is `[]` (200), shape unchanged.

Example: store is on 3.3.1, internal build 3.3.2 → set both `minVersion*` to `3.3.2`, leave
`maxVersion*` empty. Clear both (or ship 3.3.2) to go live. Before releasing 3.3.2 to the
store, either the promo is ready or `minVersion*` is raised.

Not access control: `version` is client-supplied, and the voucher stays redeemable at
checkout by anyone who knows the code. The banner that links to the promo is gated
separately (`banner.maxVersion*`, upper bound only, all banners at once).

### Known limits

- The quota check is a read, not a reservation: the last seat can sell between the
  page load and checkout, and checkout then answers `VOUCHER_INVALID`.
- Member-specific voucher rules are not evaluated here, since the endpoint is public.

Tests: `apps/mobile-api/tests/promo-public.spec.ts`.
