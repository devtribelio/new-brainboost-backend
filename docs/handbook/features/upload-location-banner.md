# Upload, Location & Banner

[⬅ Kembali ke index](../README.md)

Tiga modul kecil pendukung digabung dalam satu halaman. Semuanya di prefix `/api/member`.

---

## 1. Upload

### Overview

Upload gambar via multipart (multer, field `image`) → diproses **sharp** → disimpan ke **S3**. Tidak ada lagi disk lokal atau `/static/temporary` seperti legacy. Setiap gambar di-re-encode ke **webp**, di-downscale (longest side per `kind`, tanpa upscale), dan **EXIF/metadata di-strip** (buang GPS + netralkan payload polyglot).

Model akses **hybrid by key prefix**: `public/*` publik permanen + CDN-cacheable (avatar, cover, post image) via bucket policy; `private/*` disiapkan untuk file sensitif ke depan (presigned GET sudah didukung storage service, belum ada endpoint).

- Kode: `apps/mobile-api/src/modules/upload/`
- Spec desain: [`docs/specs/upload-s3-port.md`](../../specs/upload-s3-port.md)

### Endpoint

| Method | Path | Auth | Deskripsi |
|---|---|---|---|
| POST | `/api/member/upload/temporary?kind=` | JWT | Upload multipart (field `image`, maks **10 file**/request) → webp di S3; balikan `{ image: [{ fileId, url, fullUrl, size, ... }] }` |

Path tetap `/upload/temporary` demi kompatibilitas wire FE legacy, walau file tidak lagi "temporary".

### Business rules

1. **Flow 2 langkah, decoupled** — upload dulu (dapat `fullUrl`), lalu FE mengirim `fullUrl` sebagai string biasa ke endpoint domain (mis. update profile). Backend tidak ada di hot path untuk render `public/*`.
2. **Key layout**: `public/<folder>/<userId>/<uuid>.webp` — owner segment selalu member pengunggah (post/comment id belum ada saat upload).
3. **`kind` menentukan folder + ukuran maks** (invalid `kind` → 400): `avatar`→512px, `cover`→1280, `post`→1440, `comment`→1024, `network`→512, `general` (default)→1024.
4. **Guard DoS**: multer memoryStorage dibatasi `fileSize` (env `upload.maxBytes`), `files` = 10, `parts` = 15 — tanpa cap ini satu member bisa mem-pin heap worker (OOM).

Tabel database: tidak ada — hasil upload disimpan sebagai string URL di entitas pemakainya (`members.avatar_url`, `posts.image_urls`, dst.).

---

## 2. Location

### Overview

Referensi lokasi read-only berhierarki: country → province → city → district. Dipakai form alamat profile (`member_profiles`). Data hasil migrasi legacy (semua tabel punya `legacyId`).

- Kode: `apps/mobile-api/src/modules/location/`

### Endpoint

Semuanya publik (tanpa `authGuard`).

| Method | Path | Deskripsi |
|---|---|---|
| GET | `/api/member/data/location/country` | Daftar negara |
| GET | `/api/member/data/location/province` | Daftar provinsi (filter per country) |
| GET | `/api/member/data/location/city` | Daftar kota (filter per province) |
| GET | `/api/member/data/location/district` | Daftar kecamatan (filter per city) |

### Tabel database

| Tabel | Peran |
|---|---|
| `countries` → `provinces` → `cities` → `districts` | Hierarki referensi; FK berantai ke induknya; direferensikan `member_profiles` |

---

## 3. Banner

### Overview

Listing banner untuk home screen mobile, dengan window tayang dan flag popup.

- Kode: `apps/mobile-api/src/modules/banner/`

### Endpoint

| Method | Path | Auth | Deskripsi |
|---|---|---|---|
| GET | `/api/member/data/banner` | Publik | Daftar banner aktif yang sedang dalam window tayang |

### Tabel database & business rules

| Tabel | Peran |
|---|---|
| `banners` | Banner: `imageUrl`, `linkUrl`, urutan `position`, `isActive`, `isPopup`, window `startedAt`/`endedAt` |

1. **Window tayang**: banner tampil bila `isActive` dan `now` berada dalam `[startedAt, endedAt]` — `null` berarti tanpa batas di sisi itu.
2. **`isPopup`** membedakan banner popup dari banner strip biasa; urutan tampil pakai `position`.

---

## Referensi

- Spec upload S3 (env vars, infra checklist, follow-ups): [`docs/specs/upload-s3-port.md`](../../specs/upload-s3-port.md)
- Skema tabel: [02 — Database](../02-database.md)
