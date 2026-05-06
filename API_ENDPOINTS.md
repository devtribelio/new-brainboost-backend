# Dokumentasi API — Brainboost (mobile)

Referensi otomatis dari kode aplikasi. Path di bawah relatif terhadap **prefix** `/{base}/api/` kecuali dinyatakan lain.

## Konvensi dasar

| Item | Nilai |
|------|--------|
| **Base host** | Dari `lib/commons/constant.dart` → `Constants.baseUrl` (bergantung `Env`: dev / stage / prod). |
| **Prefix API utama** | `{baseUrl}/api/` |
| **Auth terautentikasi** | Header `Authorization: Bearer <access_token>` (diset interceptor Dio: `lib/core/network/dio_interceptor.dart`). |
| **Client HTTP** | **Dio** + **Retrofit** (`lib/core/network/remote/`) serta pemanggilan manual lewat `lib/shared/api/api_helper.dart` + konstanta `lib/shared/api/api_connection.dart`. |

### Catatan implementasi

- Beberapa endpoint tersedia lewat **dua jalur**: layanan statis (`*Service` + URL penuh) dan **Retrofit** (path relatif; base Dio = `{baseUrl}/api/`).
- **Refresh token** memakai `POST .../member/oauth/token` dengan `grant_type=refresh_token` (`AuthService`); konstanta `refreshTokenUrl` (`member/oauth/refresh`) ada di `api_connection.dart` tetapi **tidak terlihat dipakai** di codebase.
- `GET member/info`: dipakai lewat Retrofit (`AuthRemoteSource`). `appInfoUrl` di `api_connection` mengarah path yang sama; pemanggilan lewat helper saat ini terkomentari.

---

## OAuth & sesi (`member/oauth`, `member/auth`, `member/account`)

| Metode | Path penuh (relatif `/api`) | Sumber utama |
|--------|------------------------------|---------------|
| POST | `/member/oauth/token` | Retrofit `auth_remote_source`, `AuthService` |
| POST | `/member/account/preRegistration` | Retrofit `account_remote_source` |
| POST | `/member/auth/register` | `api_connection.dart` → `AuthService` |
| POST | `/member/auth/devices` | `AuthService` |
| POST | `/member/auth/cloudMessaging` | `AuthService` |
| POST | `/member/account/logout` | Retrofit + `AuthService` |
| POST | `/member/account/changePassword` | `AuthService` |
| POST | `/member/auth/requestForgotPassword` | `AuthService` |
| POST | `/member/auth/forgotPasswordVerification` | `AuthService` |
| POST | `/member/auth/validateOtp` | `AuthService` |
| GET | `/member/info` | Retrofit `auth_remote_source` |

Grant types dan body OAuth mengikuti implementasi di `AuthService` (mis. `password`, `social`, `client_credentials`, refresh).

---

## Profil & lokasi

| Metode | Path |
|--------|------|
| GET | `/member/account/profile/info` |
| POST | `/member/account/profile/update` |
| GET | `/member/data/location/country` |
| GET | `/member/data/location/province` |
| GET | `/member/data/location/city` |
| GET | `/member/data/location/district` |
| POST | `/member/account/profile/location` |

Query umum lokasi (lihat `LocationService`): `page`, `perPage`, `keyword`, serta filter id (`countryId`, `provinceId`, …) sesuai level.

---

## Upload

| Metode | Path |
|--------|------|
| POST | `/member/upload/temporary` |

- Retrofit (`GeneralRemoteSource`): multipart field **`image`** (list `MultipartFile`).
- `SharedService.uploadTemporary`: field **`image[0]`**, `image[1]`, … (paket `http`).

---

## Banner & produk / kurs / pembayaran

| Metode | Path |
|--------|------|
| GET | `/member/data/banner` |
| GET | `/member/product/list` |
| GET | `/member/product/course/detail` |
| GET | `/member/account/getPaymentToken` |
| POST | `/member/product/course/share` |
| GET | `/member/data/commisionSummary` |

Ejaan path mengikuti backend: **`commisionSummary`** (bukan “commission”).

---

## Komisi

| Metode | Path |
|--------|------|
| GET | `/member/data/commisionSummary` |

Digunakan dari `AuthService.getCommision()`.

---

## Penghapusan akun

| Metode | Path |
|--------|------|
| POST | `/member/account/requestDeleteAccount` |
| POST | `/member/account/verificationDeleteAccount` |
| POST | `/member/account/recoverAccountScheduled` |

---

## Komunitas (Retrofit)

Base sama: `{baseUrl}/api/`.

### Topik

| Metode | Path |
|--------|------|
| GET | `/member/topic/list` |
| POST | `/member/topic/subscribe` |

### Posting

| Metode | Path | Catatan |
|--------|------|---------|
| GET | `/member/post/list` | |
| GET | `/member/post/detail` | Query `postId` |
| POST | `/member/post/like` | |
| POST | `/member/post/create` | Dipakai untuk **buat** dan **ubah** posting (method berbeda di layer Dart, URL sama). |
| POST | `/member/post/delete` | |

### Komentar & balasan

| Metode | Path |
|--------|------|
| GET | `/member/comment/list` |
| GET | `/member/comment/detail` |
| POST | `/member/comment/like` |
| POST | `/member/comment/create` |
| POST | `/member/comment/update` |
| POST | `/member/comment/delete` |
| GET | `/member/reply/list` |

### Jaringan (network)

| Metode | Path |
|--------|------|
| POST | `/member/network/join` |
| GET | `/member/network/member` |
| GET | `/member/network/tag` |

### Laporan

| Metode | Path |
|--------|------|
| GET | `/member/report/category` |
| POST | `/member/report/memberReport` |
| POST | `/member/post/report` |

---

## Notifikasi

| Metode | Path |
|--------|------|
| GET | `/member/notification/list` |
| POST | `/member/notification/seen` |

---

## Supabase (bukan REST `baseUrl`)

Digunakan lewat SDK Supabase:

| Operasi | Tabel | Kebutuhan aplikasi |
|---------|-------|---------------------|
| SELECT | `mobile_version_config` | Konfig force/soft update per `platform` + `env` (`lib/shared/function/update_cheker.dart`). |

URL & anon key: `lib/commons/constant.dart`.

---

## Bunny.net & media (luar backend utama)

Konfigurasi URL dan credential ada di **`lib/shared/api/api_connection.dart`** (jangan commit secret ke dokumentasi publik tanpa penyaringan).

| Penggunaan | Perilaku di app |
|------------|------------------|
| **Storage CDN** | Unduh berkas audio: `downloadBunnynetUrl/{audioId}/original?accessKey=...&download` (`ProductService`). |
| **Video library API** | `GET https://video.bunnycdn.com/library/{libraryId}/videos/{videoId}` dengan header akses (`BunnynetService`). |

Variabel lain (`pullzone`, API key lain) dipakai fitur streaming/pengayaan konten sesuai kode pemanggilan.

---

## Pemetaan file sumber

| Area | Lokasi |
|------|--------|
| URL string (legacy/helper) | `lib/shared/api/api_connection.dart` |
| Pemanggilan HTTP umum | `lib/shared/api/api_helper.dart`, `lib/shared/api/services/*.dart` |
| Retrofit definisi endpoint | `lib/core/network/remote/**/*.dart` |
| Base URL + Bearer per request | `lib/core/network/dio_interceptor.dart` |
| Registrasi Dio / RemoteSource | `lib/core/network/di/network_module.dart` |

---

*Dokumen ini mencerminkan codebase pada saat dibuat; jika ada perbedaan dengan server, prioritaskan kontrak backend resmi.*
