# Product & Course — Katalog, Akses Materi & Media

[⬅ Kembali ke index](../README.md)

## Overview

Katalog produk (course & subscription plan) plus akses materinya: struktur `Product → Course → CourseSection → Lesson`, gerbang akses via `CourseEnrollment`, rating (`Review`), dan **media proxy** untuk streaming/download audio-video course dari BunnyCDN tanpa membocorkan identitas aset.

Dua modul terlibat:

- **product** (`apps/mobile-api/src/modules/product/`) — listing + detail course, parity dengan legacy `TBProduct`/`TBCourse`. Detail menyertakan preview rentang komisi affiliate (via `AffiliatorService`).
- **media** (`apps/mobile-api/src/modules/media/`) — proxy BunnyCDN Stream; satu-satunya pintu client mengambil MP4.

Pembelian course ada di [commerce](commerce.md); akses via langganan di [subscription](subscription.md).

## Endpoint

Prefix modul: `/api/member`.

| Method | Path | Auth | Deskripsi |
|---|---|---|---|
| GET | `/api/member/product/list` | JWT | Daftar produk (filter via query DTO `ListProductsQueryDto`) |
| GET | `/api/member/product/list/public` | Opsional | Varian publik untuk user belum login (`optionalAuthGuard`) — handler sama |
| GET | `/api/member/product/course/detail` | JWT | Detail course: sections + lessons, status enrollment, rating agregat, preview komisi |
| GET | `/api/member/product/course/detail/public` | Opsional | Varian publik detail (tanpa state member) |
| POST | `/api/member/product/course/share` | JWT | Share course (menghasilkan link share) |
| GET | `/api/member/media/stream` | Opsional* | Stream MP4 lesson via token opaque `streamUrl`. `HEAD` ikut ke handler yang sama (probe player) |
| GET | `/api/member/media/download` | Opsional* | Download audio: 302 → signed Bunny MP4 URL long-lived; **rate limit 10 req/menit per member** (fallback per IP; `mediaDownloadRateLimiter`, anti bulk-scraping) |

\* `optionalAuthGuard`: request anonim tidak ditolak di middleware — lesson `isPreview` memang harus bisa diputar tanpa login; **controller** yang menegakkan auth + enrollment untuk media non-preview.

## Tabel database

| Tabel | Peran di fitur ini |
|---|---|
| `products` | Entitas jual: harga, status, SKU store; `type` membedakan course vs subscription plan |
| `courses` | Detail course 1:1 product (`durationMin`, `programDays` untuk listening challenge) |
| `course_sections` / `course_lessons` | Struktur materi; `Lesson.isPreview` = boleh diputar tanpa enrollment; `slidesData` JSONB |
| `course_enrollment` | Gerbang akses: unique (member, course); `via_subscription_id` membedakan retail vs lazy |
| `reviews` | Rating 1–5 per (product, member) — ditampilkan agregat di detail course. Belum ada endpoint tulis di mobile-api; datanya diisi legacy resync |
| `banners` | Banner home — modul terpisah, lihat halaman upload-location-banner.md *(menyusul)* |

## Business rules

1. **Aturan akses materi** — lesson `isPreview` bebas diakses siapa pun; lesson non-preview mensyaratkan `CourseEnrollment` yang valid. Validitas enrollment mengikuti aturan sakral subscription: row retail (`via_subscription_id` NULL) valid **by existence** (`expired_date` legacy DIABAIKAN); row lazy valid hanya selama `expired_date > now`. Detail: [subscription.md — aturan enrollment](subscription.md#aturan-enrollment).
2. **Bunny referrer-gating ≠ access control** — audio + video course hidup di **satu** Bunny Stream library (id `157244`, CDN `vz-5439ef3e-878.b-cdn.net`); tidak ada Storage zone terpisah. Proteksi bawaan Bunny hanya referrer-gating (header `Referer` apa pun → 200) yang cuma hotlink protection. Access control sesungguhnya ada di backend ini.
3. **`guid`/`videoLibraryId` tidak pernah sampai client** — serializer product mengeluarkan `streamUrl` berisi **token opaque**; modul media menukar token itu menjadi proxy MP4 rendition (stream) atau 302 ke signed URL (download). Client tidak pernah bisa menyusun URL Bunny sendiri.
4. **HEAD = GET tanpa body** — Express mengarahkan `HEAD` ke handler `GET`; controller cek `req.method` untuk melewatkan body. Penting untuk probe durasi/range dari audio player.
5. **Download di-rate-limit 10 req/menit per member** (fallback per IP) — mencegah scripted bulk-scraping seluruh katalog; stream sengaja tidak di-throttle (playback normal cuma sekali hit per sesi). Gating auth/enrollment-nya sama persis dengan stream.
6. **Preview komisi di detail** — detail course menampilkan rentang komisi affiliate (pakai `products.ios_price` bila ada, untuk offset markup IAP) — dihitung `AffiliatorService`, aturan di halaman affiliate *(menyusul)*.

## Referensi

- Spec media proxy: [`docs/specs/media-port.md`](../../specs/media-port.md)
- Pemetaan simbol legacy (TBProduct/TBCourse/TBPlan): [`docs/specs/legacy-analysis.md`](../../specs/legacy-analysis.md)
- Pembelian: [commerce.md](commerce.md) · Akses via langganan: [subscription.md](subscription.md)
