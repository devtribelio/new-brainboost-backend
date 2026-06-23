# API Response Envelope

Single canonical shape for every JSON response from `bb-backend-new`. Replaces the prior triad (`{errCode,errMessage,data}`, `okLegacy` `{meta,data:[]}`, `buildLegacyPage` `{items,currentPage,...}`) — those helpers are gone.

## Envelope

### Success

```json
{
  "success": true,
  "data": <T>,
  "meta": null,
  "error": null
}
```

### Created (HTTP 201)

Same shape, status code 201. Use for POST endpoints that produce a resource:

- `POST /api/member/auth/register`
- `POST /api/member/post/create`, `/comment/create`, `/post/report`, `/report/memberReport`
- `POST /api/member/product/checkout/submit`, `/payment/commerce`
- `POST /api/member/affiliate/programs/:code/enroll`

### Paginated

```json
{
  "success": true,
  "data": [<T>, ...],
  "meta": {
    "pagination": { "page": 1, "perPage": 20, "total": 137, "totalPages": 7 }
  },
  "error": null
}
```

Helpers can add extra meta fields next to `pagination` — e.g. notification list includes `meta.unread` and `meta.totalAll`.

### Error

```json
{
  "success": false,
  "data": null,
  "meta": null,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "details": [
      { "field": "email", "constraints": { "isEmail": "email must be an email" } }
    ]
  }
}
```

`details` is optional — present for `VALIDATION_ERROR` (array of `{ field, constraints }`), for thrown `HttpException(details)`, and in non-production for unhandled errors (stack snippet).

## Error Code Vocabulary

| Code | HTTP | When |
|---|---|---|
| `BAD_REQUEST` | 400 | Generic 400; default for `BadRequestException` |
| `VALIDATION_ERROR` | 400 | DTO validation failure; `details` carries field errors |
| `UNAUTHORIZED` | 401 | Missing/invalid bearer; `UnauthorizedException` |
| `FORBIDDEN` | 403 | Authenticated but not permitted; `ForbiddenException` |
| `NOT_FOUND` | 404 | Resource or route absent; `NotFoundException` / `notFoundHandler` |
| `CONFLICT` | 409 | Duplicate / state conflict |
| `UNPROCESSABLE_ENTITY` | 422 | Semantically rejected |
| `TOO_MANY_REQUESTS` | 429 | Rate-limited |
| `INTERNAL_ERROR` | 500 | Unhandled; logged via pino |
| `NOT_IMPLEMENTED` | 501 | `notImplemented()` helper |

Throw `new BadRequestException(message, details, code)` to override the default `BAD_REQUEST` code (e.g. validation middleware uses `VALIDATION_ERROR`).

## Helper Signatures (`src/common/utils/response.util.ts`)

```ts
ok<T>(res, data: T, meta?: Meta, status = 200): Response
okCreated<T>(res, data: T, meta?: Meta): Response           // 201
okPaginated<T>(res, items: T[], { page, perPage, total }, extraMeta?): Response
fail(res, status, code, message, details?): Response
notImplemented(res, name?): Response                         // 501, code NOT_IMPLEMENTED
```

## Anomalies (intentional)

- **`POST /api/webhook/xendit/invoice`** — returns raw `{ received: true, ... }`. Provider contract: Xendit only checks HTTP 2xx, ignores body. Not wrapped.

## OpenAPI Mapping

`@ApiResponse({ envelope: ... })` controls the documented shape:

- `'standard'` (default) → wraps `type` in success envelope
- `'paginated'` → wraps `type[]` with `meta.pagination`
- `'none'` → emits `type`/`schema` as-is (use for error responses with `ErrorEnvelopeDto`, and for the webhook)

`PaginationMetaDto`, `ApiErrorDto`, `ErrorEnvelopeDto` are pre-registered globally in `src/common/openapi/builder.ts`.

## Mobile FE Migration

Big-bang rollout: backend + mobile clients ship together. There is **no dual-shape compatibility layer** — old clients will break against this backend version. Coordinate the release.

Client parser checklist:

1. Read top-level `success` to branch; ignore the old `errCode === 0`.
2. Read `data` directly — paginated lists are arrays now, not `{items: [...]}`.
3. Read pagination at `meta.pagination` — `{page, perPage, total, totalPages}` instead of `{currentPage, lastPage}`.
4. Error handling: `error.code` for branching, `error.message` for display, `error.details` for field-level validation.
5. Notification list moved `unread` and `totalAll` into `meta` (`meta.unread`, `meta.totalAll`).
6. Login response is now wrapped: read tokens from `response.data.access_token` (was top-level `access_token`).
