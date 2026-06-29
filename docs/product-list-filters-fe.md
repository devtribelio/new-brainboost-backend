# Product List — Filters & Sort (FE integration)

Audience: mobile/web FE. Covers the **filter** and **sort** query params on the product
list endpoint. Nothing here is breaking — every param is optional and the default
behavior is unchanged (`newest` order, no filtering).

Applies to **both** variants (same query contract, same response):

| Route | Auth |
|---|---|
| `GET /api/member/product/list` | Bearer (member) |
| `GET /api/member/product/list/public` | optional Bearer (guest allowed) |

> The legacy doc entry for this endpoint is `docs/api-fe.md` §55. The response shape
> (`ProductModel`) is unchanged — only new request params + a new `type` value.

---

## Query parameters

| Param | Type | Default | Notes |
|---|---|---|---|
| `page` | int ≥ 1 | `1` | |
| `perPage` | int ≥ 1 | `100` | |
| `keyword` | string (≤200) | — | case-insensitive match on product title |
| `type` | enum | — | `course` \| `mini_course`. Omit = all types. |
| `sort` | enum | `newest` | `price_asc` \| `price_desc` \| `newest` \| `top_rated` |
| `media` | enum[] | — | `audio` \| `video`. Repeatable or CSV. Multi = **AND**. |
| `ownership` | enum | — | `purchased` \| `not_purchased`. Ignored for guests. |

Validation is strict: an unknown `type`/`sort`/`media` value → `400 VALIDATION_ERROR`
(envelope `error.code`). Send the exact lowercase tokens above.

### `type`
- `course` — full course.
- `mini_course` — **new** product type (shorter course). Same response shape as a
  course; `course/detail` works for it too. In the response, `typeLabel` is `"Mini Course"`.
- Omit the param to list everything.

### `sort`
| Value | Order |
|---|---|
| `price_asc` | cheapest → priciest |
| `price_desc` | priciest → cheapest |
| `newest` *(default)* | newest created first |
| `top_rated` | highest average review stars first (no reviews sort last) |

### `media`
Filters by the media kind a course actually contains (audio lessons vs video lessons).

- Single: `?media=audio` → courses that contain audio.
- Multiple → **AND**: the course must contain **all** selected kinds.
  - `?media=audio&media=video` (or `?media=audio,video`) → only courses that have **both**
    audio **and** video content.

> **AND, not OR.** Passing both values narrows the result to courses that have every
> selected media kind. To show "audio or video", make two separate requests (or just omit
> `media`, since most catalog items have at least one).

### `ownership` + `sort` interaction
When `ownership=purchased` (authenticated only), results are **always** ordered by
purchase date (most recent first) and the `sort` param is **ignored**. For all other
cases `sort` applies normally. `ownership=not_purchased` honors `sort`.

---

## Request examples

```
# Mini courses, cheapest first
GET /api/member/product/list?type=mini_course&sort=price_asc

# Top-rated courses that have video content
GET /api/member/product/list?sort=top_rated&media=video

# Courses that contain BOTH audio and video, searched by keyword
GET /api/member/product/list?media=audio,video&keyword=react

# Public catalog (guest), newest first (default)
GET /api/member/product/list/public
```

---

## Response

Standard **paginated envelope** (see `docs/api-envelope.md`). Unchanged from before —
the same `ProductModel` items; `data` is the array, pagination in `meta.pagination`.

```jsonc
{
  "success": true,
  "data": [
    {
      "id": 1234,
      "type": "mini_course",
      "typeLabel": "Mini Course",     // "Course" for type=course
      "code": "abc123",
      "slug": "react-basics",
      "name": "React Basics",
      "category": ["frontend"],
      "price": 200000,
      "imageUrl": "https://...",
      "isPurchased": false,
      "productRatingAvg": 4.5,
      "shareUrl": "https://...",
      "commisionFixAmount": 40000     // existing field (sic spelling kept)
      // ... other existing ProductModel fields unchanged
    }
  ],
  "meta": {
    "pagination": { "page": 1, "perPage": 100, "total": 12, "totalPages": 1 }
  },
  "error": null
}
```

`meta.pagination.total` reflects the **filtered** result count, so paging works correctly
with any combination of `type` / `media` / `keyword` / `ownership`.

---

## Notes / gotchas for FE

- **All params are optional and composable** — combine `type` + `media` + `sort` +
  `keyword` freely in one request.
- **`mini_course` is a content/admin flag**, not a structural difference: render it like a
  course; branch UI on `type` only if the design needs a distinct badge (use `typeLabel`).
- **`top_rated`** ranks by average of submitted reviews; brand-new products with zero
  reviews fall to the bottom (not hidden).
- **`media` reflects real lesson content** (audio vs video slides), not a manual tag. With
  multiple values it's **AND** — a course must have every selected kind to match.
- No client migration needed for existing calls; the old `?page=&perPage=&keyword=&type=`
  requests behave exactly as before.
