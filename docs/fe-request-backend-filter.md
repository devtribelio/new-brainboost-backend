# Backend Filters Needed

Audit of client-side filtering currently applied on top of API responses. Each section identifies a filter the frontend performs in JavaScript that should ideally move to the backend (as query params or a dedicated endpoint).

Branch: `feat/history-enhancement` · Audit date: 2026-05-22

---

## 1. Transactions list

**Endpoint**: `GET /api/member/payment/commerce/list`

**Frontend code**: [`features/checkout/components/TransactionList.tsx`](../features/checkout/components/TransactionList.tsx) — `applyFilters()` and `TAB_MATCHERS`

### Filters applied client-side

| # | Filter | Source field | Suggested query param | Notes |
|---|---|---|---|---|
| 1 | **Status** | `status` | `?status=PENDING\|PAID\|CANCELED\|EXPIRED` | The UI folds `EXPIRED` into the "Cancelled" tab. Backend should accept multiple values (e.g. comma-separated `?status=CANCELED,EXPIRED`) or repeated params. |
| 2 | **Product name search** | `product.title` | `?search=<text>` | Case-insensitive substring match. Frontend debounces input by 300ms. |
| 3 | **Created-at: from** | `createdAt` | `?createdFrom=<ISO 8601>` | Inclusive lower bound. |
| 4 | **Created-at: to** | `createdAt` | `?createdTo=<ISO 8601>` | Inclusive upper bound. Frontend normalizes to end-of-day (23:59:59.999) when only a date is picked — backend should match this semantics or document its own convention. |

### Why it matters

The current implementation fetches **all** transactions (paginated infinite scroll) then filters in-memory. Consequences:

- Per-tab pagination is wrong. Each fetched "page" can contain mostly items the user isn't currently viewing.
- Counts on tabs (e.g. `Paid 3`) are only accurate after the user has scrolled through all pages.
- Empty states for narrow tabs (e.g. "Pending" with no matches on the first page) require fetching all remaining pages to confirm.

### Acceptance criteria

- All four params above accepted, combinable, and reflected in the response's `meta.pagination.total`.
- Status param accepts multi-value selection.
- Existing `?page=` and `?perPage=` pagination continues to work.

---

## 2. Product browse list (signed-in users)

**Endpoint**: `GET /api/member/product/list/public`

**Frontend code**: [`features/product/components/ProductList.tsx:27-30`](../features/product/components/ProductList.tsx)

### Filter applied client-side

| # | Filter | Source field | Suggested query param | Notes |
|---|---|---|---|---|
| 1 | **Exclude already-purchased items** | `isPurchased` | `?excludeOwned=true` *or* `?ownership=not_purchased` | Only relevant when authenticated. Guest users see everything. |

### Why it matters

- Signed-in users briefly see products they own during fetch, then they get filtered out — visible flicker.
- Pagination is misleading. A "page of 24" may display only 18 items to the user.
- Infinite scroll behaves inconsistently because the filtered count never matches `meta.pagination.total`.

### Acceptance criteria

- Param respected only for authenticated requests (or silently ignored for guests).
- `meta.pagination.total` reflects the filtered count.

---

## 3. My Purchases list

**Endpoint** (current workaround): `GET /api/member/product/list/public`

**Frontend code**: [`features/product/components/MyPurchasesList.tsx`](../features/product/components/MyPurchasesList.tsx) — already has a TODO comment about this.

### Filter applied client-side

| # | Filter | Source field | Notes |
|---|---|---|---|
| 1 | **Only purchased items** | `isPurchased === true` | Inverse of the filter in §2. |

### Why it matters (worst case)

The current code eagerly fetches **every page** of the public product list and runs the client-side filter. For a user with 5 purchases scattered across page 12 of the catalogue, the app fetches all 12 pages just to display 5 items.

### Suggested fix

Dedicated endpoint, e.g.:

```
GET /api/member/product/my-purchases
GET /api/member/product/list/owned
```

Likely needs different fields than the public list:

- Purchase / payment date
- Course progress (if applicable)
- License / access expiry (if applicable)

A simple `?ownership=purchased` inverse-flag on the public list would also work but a dedicated endpoint is more efficient and gives room to evolve the payload independently.

### Acceptance criteria

- Returns only the authenticated user's purchased products.
- Paginated with the same `meta.pagination` envelope.
- Sortable by purchase date (descending by default).

---

## Already server-side (no action needed)

- Product list `?keyword=` — works correctly today.

---

## Summary table

| Endpoint | Params to add | Or new endpoint |
|---|---|---|
| `GET /api/member/payment/commerce/list` | `status` (multi), `search`, `createdFrom`, `createdTo` | — |
| `GET /api/member/product/list/public` | `excludeOwned` (or `ownership`) | — |
| *(my purchases)* | — | `GET /api/member/product/my-purchases` |
