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

**Single source of truth: `packages/common/src/exceptions/error-codes.ts` (`ERROR_CODES`).** Read that file for the full list; the tables below explain the two tiers. Codes are typed (`ErrorCode`), so a typo is a compile error and a code that isn't in the catalog cannot be thrown.

### Tier 1 — generic (fallback only)

These duplicate the HTTP status and therefore carry **no** information a client didn't already have. They are what an exception falls back to when no explicit code is given, plus what `statusToCode()` assigns to raw throws and unmapped Prisma failures.

| Code | HTTP | When |
|---|---|---|
| `BAD_REQUEST` | 400 | Default for `BadRequestException` |
| `VALIDATION_ERROR` | 400 | DTO validation failure; `details` carries field errors |
| `UNAUTHORIZED` | 401 | Default for `UnauthorizedException` |
| `FORBIDDEN` | 403 | Default for `ForbiddenException` |
| `NOT_FOUND` | 404 | Default for `NotFoundException` / `notFoundHandler` |
| `CONFLICT` | 409 | Duplicate / state conflict (Prisma P2002) |
| `UNPROCESSABLE_ENTITY` | 422 | Semantically rejected |
| `TOO_MANY_REQUESTS` | 429 | Rate-limited |
| `INTERNAL_ERROR` | 500 | Unhandled; logged via pino |
| `NOT_IMPLEMENTED` | 501 | `notImplemented()` helper |

### Tier 2 — specific (what clients branch on)

Grouped by domain in the catalog: session/token (`BEARER_TOKEN_MISSING`, `ACCESS_TOKEN_INVALID`, `REFRESH_TOKEN_EXPIRED`, `SESSION_REVOKED`, …), credentials (`INVALID_CREDENTIALS`, `MEMBER_INACTIVE`, …), social sign-in (`GOOGLE_ID_TOKEN_INVALID`, `EMAIL_IN_USE_UNVERIFIED`, …), OTP (`OTP_EXPIRED`, `OTP_LOCKED`, `OTP_RESEND_TOO_SOON`, …), KYC (`KYC_NOT_APPROVED`, `KYC_IN_REVIEW`, `KYC_BALANCE_INSUFFICIENT`, …), disbursement (`BANK_ACCOUNT_MISSING`, `DISBURSEMENT_ALREADY_PENDING`, …), commerce (`TRANSACTION_NOT_PENDING`, `PAYMENT_IN_PROGRESS`, `VOUCHER_EXHAUSTED`, …).

### How to raise an error

**Never construct an exception with a literal message.** Use the factories — they pull the Indonesian copy from `error-messages.ts`, so one condition renders one sentence everywhere it is raised:

```ts
import { badRequest, notFound, ERROR_CODES } from '@bb/common/exceptions';

throw badRequest(ERROR_CODES.OTP_EXPIRED);
throw notFound(ERROR_CODES.TRANSACTION_NOT_FOUND);
throw badRequest(ERROR_CODES.POST_CONTENT_TOO_LONG, { max: MAX_CONTENT_CHARS }); // details
```

`badRequest` / `unauthorized` / `forbidden` / `notFound` pick the HTTP status (400/401/403/404); the code picks the copy. All 317 throw sites in the repo use this form — a literal message anywhere is a regression.

### User-facing copy is Bahasa Indonesia

`packages/common/src/exceptions/error-messages.ts` holds one Indonesian sentence per code, typed `Record<ErrorCode, string>` so a code without copy is a compile error. The mobile client displays `error.message` verbatim — **treat a change there as a UI change.**

Style (follows the messages that predated the catalog, e.g. "Rekening belum diisi"): neutral, no pronouns (`Anda`/`kamu`), sentence case, no trailing period, describe the condition and the next step. Server-to-server codes (`INGEST_*`, `WEBHOOK_*`) stay English on purpose — they answer Xendit/Didit/RevenueCat, never a human.

### Rules

- A code describes the **condition**, not the endpoint — the same condition reached from two routes reports the same code. `PRODUCT_NOT_FOUND` is one code even where one route answers 400 and another 404.
- A code is a permanent part of the public API: never rename or reuse one. Add a new code and leave the old in place while old app builds are still in the wild.
- Don't encode the HTTP status in the code; that's the status line's job.
- **Anything the client must branch on needs a Tier-2 code.** Adding a distinct message without a code recreates the inversion described below.
- **Never interpolate a dynamic value into a message** — limits, offending input, internal enums and timestamps go in `details`. The message is product copy and must not leak field names, enum values or raw client input.

### Why Tier 2 exists (history)

Until 2026-07 only ONE of 317 throw sites passed a code, so `error.code` was a pure function of the status (`code === statusToCode(status)`) — 93 distinct messages collapsed into `BAD_REQUEST` alone. The only way to tell "OTP expired" from "OTP locked" was to string-match `error.message`, i.e. exactly the inverse of item 4 in the FE checklist below. That made `message` the de-facto API key: rewording or translating any message was a silent breaking change, invisible to the type checker, and it blocked translating user-facing copy to Indonesian.

Fixed in two steps, both landed 2026-07-30: codes were added first (additively, messages untouched), then every message was replaced with Indonesian copy from the catalog. Coverage is now complete — all 317 throw sites plus the error middleware, the Prisma mapper and the rate limiter. `apps/mobile-api/tests/error-codes.spec.ts` pins the codes and asserts no English string can re-enter the user-facing catalog.

**This was a breaking change for any client matching on `error.message` or on the old generic codes.** Frontend handoff (full old → new mapping, HTTP status vocabulary, migration checklist): `docs/frontend-error-contract-migration.md`.

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
