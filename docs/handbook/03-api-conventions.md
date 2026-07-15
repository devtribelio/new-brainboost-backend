# 03 — Konvensi API

[⬅ Kembali ke index](README.md)

Ringkasan kontrak yang berlaku untuk **semua** endpoint JSON di `mobile-api`. Spec envelope penuh (termasuk checklist migrasi parser mobile): [`docs/specs/api-envelope.md`](../specs/api-envelope.md).

## 1. Response envelope

Satu bentuk kanonis untuk semua response — helper di `packages/common/src/utils/response.util.ts`:

```ts
ok<T>(res, data, meta?, status = 200)                          // sukses
okCreated<T>(res, data, meta?)                                 // 201 — POST yang mencipta resource
okPaginated<T>(res, items, { page, perPage, total }, extraMeta?) // list berhalaman (totalPages dihitung otomatis)
fail(res, status, code, message, details?)                     // error manual (jarang — biasanya lewat exception)
notImplemented(res, name?)                                     // 501 NOT_IMPLEMENTED
```

### Sukses

```json
{ "success": true, "data": { "id": "0197…", "title": "…" }, "meta": null, "error": null }
```

### Paginated

```json
{
  "success": true,
  "data": [ { "…": "…" } ],
  "meta": { "pagination": { "page": 1, "perPage": 20, "total": 137, "totalPages": 7 } },
  "error": null
}
```

Field meta tambahan boleh berdampingan dengan `pagination` — contoh: list notifikasi menyertakan `meta.unread` dan `meta.totalAll`.

### Error

```json
{
  "success": false,
  "data": null,
  "meta": null,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "details": [ { "field": "email", "constraints": { "isEmail": "email must be an email" } } ]
  }
}
```

`error.details` opsional: terisi untuk `VALIDATION_ERROR` (array `{field, constraints}`), untuk exception yang dilempar dengan `details`, dan (non-production saja) potongan stack pada error tak tertangkap.

> ⚠️ **Anomali yang disengaja:** `POST /api/webhook/xendit/invoice` membalas mentah `{ received: true, … }` tanpa envelope — kontrak provider (Xendit hanya cek HTTP 2xx).

## 2. Error codes & exceptions

Di service/controller **jangan panggil `fail()` langsung** — lempar exception; `errorHandler` yang memetakan ke envelope:

| Exception | HTTP | `error.code` default |
|---|---|---|
| `BadRequestException` | 400 | `BAD_REQUEST` |
| (gagal validasi DTO) | 400 | `VALIDATION_ERROR` |
| `UnauthorizedException` | 401 | `UNAUTHORIZED` |
| `ForbiddenException` | 403 | `FORBIDDEN` |
| `NotFoundException` / route tak ada | 404 | `NOT_FOUND` |
| — | 409 | `CONFLICT` (duplikat / konflik state) |
| — | 422 | `UNPROCESSABLE_ENTITY` |
| rate limiter | 429 | `TOO_MANY_REQUESTS` |
| error tak tertangkap | 500 | `INTERNAL_ERROR` (ter-log via pino) |
| `notImplemented()` | 501 | `NOT_IMPLEMENTED` |

Kode bisa di-override: `new BadRequestException(message, details, code)`.

## 3. Autentikasi

- **Bearer JWT** di header `Authorization: Bearer <access_token>`. Payload memuat `sub` (member UUID), `email`, `scope`, `sid` (id session = row `refresh_tokens`).
- `authGuard` (di `packages/common/src/middlewares/auth.middleware.ts`) memverifikasi token, mewajibkan `scope=member`, **dan mengecek session masih hidup** (row `refresh_tokens` ada & belum `revokedAt`) — logout benar-benar mematikan access token, bukan hanya refresh token. Hasilnya menempel di `req.user`:

```ts
interface AuthenticatedUser { id: string; email?: string; scope: string; sessionId?: string }
```

Varian guard:

| Guard | Beda dengan `authGuard` |
|---|---|
| `authGuardLenient` | Skip cek session-aktif — untuk endpoint yang harus tetap bisa dipanggil setelah session dicabut (cleanup logout: deregister FCM, dsb.) |
| `optionalAuthGuard` | Token tidak wajib; kalau ada & valid → `req.user` terisi, kalau invalid → diabaikan diam-diam |
| `anonOrMemberGuard` | Wajib bertoken, tapi menerima scope selain `member` (mis. token anonim); cek session hanya untuk scope member |

- **Refresh:** `POST /api/member/oauth/token` dengan `grant_type=refresh_token` — **bukan** `/oauth/refresh` (konstanta `refreshTokenUrl` di mobile client lama menunjuk path yang tidak dipakai; jangan terkecoh). Grant lain yang didukung: `password`, `social`, `client_credentials`.
- Response login ter-wrap envelope: token dibaca dari `response.data.access_token`.

## 4. Validasi DTO

DTO class + decorator `class-validator`; middleware `validateDto()` men-transform (`class-transformer`) lalu memvalidasi **di edge** — di dalam service bentuknya sudah dipercaya, tanpa null-walking defensif:

```ts
bindRoute({ …, middlewares: [authGuard, validateDto(CreatePostDto)] });          // req.body
bindRoute({ …, middlewares: [authGuard, validateDto(ListQueryDto, 'query')] });  // req.query
```

Gagal validasi → `400 VALIDATION_ERROR` dengan `details` per field (lihat §1).

## 5. Routing & OpenAPI (`bindRoute`)

Semua route didaftarkan lewat `bindRoute()` (`packages/common/src/openapi/route-binder.ts`) — **jangan** `router.post(...)` langsung. Satu panggilan mengerjakan dua hal, jadi path tidak pernah punya dua sumber kebenaran:

1. Bind Express: `[...middlewares, asyncHandler(controller[handlerKey])]`.
2. Registrasi metadata OpenAPI keyed `(controller class, methodKey)`. Flag bearer-auth terdeteksi **otomatis** dari middleware yang menempel (guard di §3 membawa simbol `REQUIRES_BEARER_AUTH`).

Hasilnya tampil di Swagger UI: **`/api/docs`**. Bentuk response yang terdokumentasi dikontrol `@ApiResponse({ envelope: 'standard' | 'paginated' | 'none' })` — `none` untuk error schema & webhook.

## 6. Konvensi path & ID

- Path = `/api/<prefix>/<path-gaya-legacy>` mengikuti apa yang sudah dipanggil mobile client — **jangan di-REST-ify**. Contoh yang benar dipertahankan: `/api/member/oauth/token`, `/api/member/product/checkout/submit`, `/api/member/post/create`.
- **ID ganda**: primary key internal = UUID v7 (string); hampir semua entitas juga punya `legacyId` (int, unique) karena mobile app lama masih mengirim ID int di sebagian endpoint. Serializer yang melayani endpoint parity legacy mengemisi ID int tersebut (mis. `courseId`, `courseSectionId`, `courseLessonId`). Jangan menganggap kolom `legacyId` bisa dihapus — lihat [02 — Database §1](02-database.md).

## Referensi

- Spec envelope penuh + checklist migrasi FE: [`docs/specs/api-envelope.md`](../specs/api-envelope.md)
- Helper: `packages/common/src/utils/response.util.ts` · Guards: `packages/common/src/middlewares/auth.middleware.ts` · Binder: `packages/common/src/openapi/route-binder.ts`

---

⬅ [02 — Database](02-database.md) · Lanjut: [features/commerce.md](features/commerce.md)
