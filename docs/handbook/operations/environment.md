# Operations — Konfigurasi (Env & Runtime Settings)

[⬅ Kembali ke index](../README.md)

Konfigurasi hidup di dua lapisan yang berbeda tujuan:

| Lapisan | Sumber | Kapan berubah | Contoh |
|---|---|---|---|
| **Env var** | `packages/common/src/config/env.ts` — satu deklarasi per variabel (`required()` / `optional()`) | Deploy-time; ganti nilai = restart proses | secret, URL, kredensial provider |
| **Runtime setting** | Tabel `app_settings` via `SettingsService` (`SETTING_KEYS`) — cache in-memory TTL **30 detik** | Runtime; edit row DB, efektif ≤ 30s **tanpa redeploy** | angka bisnis yang sering di-tune (fee, threshold, grace) |

Aturan praktis: angka yang mungkin diubah tim bisnis/ops → `app_settings`; identitas, secret, dan wiring infrastruktur → env.

## 1. Environment variables

Semua dideklarasikan di `packages/common/src/config/env.ts` (env resync terpisah — lihat §1.13). Var tanpa keterangan "**wajib**" bersifat opsional dengan default masuk akal; nilai default lihat langsung file-nya. Jangan menaruh nilai/secret di dokumen ini.

### 1.1 Core

| Var | Sifat | Kegunaan |
|---|---|---|
| `NODE_ENV` | opsional (`development`) | Mode app; beberapa var lain jadi wajib saat `production` |
| `APP_NAME`, `PORT`, `BASE_URL` | opsional | Identitas app + port + base URL publik |
| `DATABASE_URL` | **wajib** | Koneksi PostgreSQL (dipakai Prisma) |
| `API_DOCS_ENABLED` | opsional (on) | Ekspos Swagger UI/OpenAPI; set `false` di prod publik |
| `TRUST_PROXY` | opsional (off) | `trust proxy` Express — wajib di-set di belakang LB agar rate-limit per-IP benar |
| `LOG_LEVEL` | opsional (`info`) | Level pino |

### 1.2 Auth (JWT & OAuth)

| Var | Sifat | Kegunaan |
|---|---|---|
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | **wajib** | Signing key token access/refresh |
| `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN`, `JWT_ANON_EXPIRES_IN` | opsional | TTL token |
| `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` | opsional | Kredensial grant `client_credentials` mobile |
| `GOOGLE_CLIENT_IDS` | opsional (CSV) | Audience verifikasi Google Sign-In |
| `APPLE_CLIENT_IDS` | opsional (CSV) | Audience (bundle id) Sign in with Apple; kosong = flow lapor "not configured" |
| `ADMIN_JWT_SECRET` | **wajib** | Signing key JWT admin |
| `ADMIN_JWT_TTL`, `ADMIN_COOKIE_NAME` | opsional | TTL + nama cookie admin |

### 1.3 Upload & S3

| Var | Sifat | Kegunaan |
|---|---|---|
| `UPLOAD_TEMP_DIR`, `UPLOAD_MAX_BYTES`, `UPLOAD_PUBLIC_BASE_URL` | opsional | Staging multer + batas ukuran |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET` | **wajib di prod** | Kredensial + bucket (dev boleh kosong) |
| `S3_ENDPOINT`, `S3_REGION`, `S3_FORCE_PATH_STYLE` | opsional | Endpoint custom (MinIO/R2) + region + path-style |
| `S3_PUBLIC_BASE_URL` | opsional | Base URL CDN untuk objek `public/*` |
| `S3_PRESIGN_EXPIRES` | opsional | TTL presigned-GET objek `private/*` |
| `S3_IMAGE_MAX_DIMENSION`, `S3_IMAGE_WEBP_QUALITY` | opsional | Parameter re-encode gambar (sharp → webp) |

### 1.4 CORS

| Var | Sifat | Kegunaan |
|---|---|---|
| `CORS_ALLOWED_ORIGINS` | opsional (CSV; kosong = `*`) | Allowlist origin browser — wajib diisi bila web FE butuh credentials |
| `CORS_CREDENTIALS` | opsional (off) | `Access-Control-Allow-Credentials`; hanya efektif dengan allowlist |

### 1.5 Xendit (payment & disbursement)

| Var | Sifat | Kegunaan |
|---|---|---|
| `XENDIT_SECRET_KEY` | opsional* | API key server-to-server (charge + payout). *Wajib secara fungsional agar pembayaran jalan |
| `XENDIT_CALLBACK_TOKEN` | opsional* | Verifikasi header `X-Callback-Token` webhook invoice & disbursement |
| `XENDIT_INVOICE_SUCCESS_URL`, `XENDIT_INVOICE_FAILURE_URL` | opsional | Redirect hosted checkout |

### 1.6 Didit (KYC) & Re-KYC

| Var | Sifat | Kegunaan |
|---|---|---|
| `DIDIT_API_KEY` | opsional | Header `x-api-key` server-to-server; kosong = KYC Didit disabled (endpoint 503, webhook fail-closed) |
| `DIDIT_WEBHOOK_SECRET` | opsional | Verifikasi HMAC-SHA256 `X-Signature` raw body (bukan apiKey!) |
| `DIDIT_WORKFLOW_ID` | opsional | UUID workflow verifikasi (ID doc + liveness + face match) |
| `DIDIT_BASE_URL`, `DIDIT_CALLBACK_URL` | opsional | Base URL API + deep link balik dari webview |
| `REKYC_DORMANT_DAYS` | opsional (365) | Reaktivasi setelah idle > N hari → reset KYC |
| `REKYC_LARGE_DISBURSEMENT_IDR` | opsional (5.000.000) | Payout ≥ N + review basi → re-KYC |
| `REKYC_STALE_DAYS` | opsional (180) | Definisi "review basi" |

### 1.7 RevenueCat (IAP)

| Var | Sifat | Kegunaan |
|---|---|---|
| `REVENUECAT_WEBHOOK_AUTH` | opsional | Shared secret header `Authorization` webhook; kosong = endpoint 401 (fail-closed) |
| `REVENUECAT_PROVIDER_NAME` | opsional (`revenuecat`) | Nama row `third_party_credentials` untuk toggle per-channel |

### 1.8 Commerce

| Var | Sifat | Kegunaan |
|---|---|---|
| `COMMERCE_TRANSACTION_EXPIRY_HOURS`, `COMMERCE_INVOICE_EXPIRY_HOURS` | opsional (24) | Umur transaksi/invoice PENDING sebelum disapu job expire |

### 1.9 FCM (push)

| Var | Sifat | Kegunaan |
|---|---|---|
| `FCM_PROJECT_ID` | opsional | Project Firebase |
| `FCM_SERVICE_ACCOUNT_JSON` | opsional | Service account: JSON inline ATAU path file; kosong = push disabled diam-diam |

### 1.10 BunnyCDN & Media

| Var | Sifat | Kegunaan |
|---|---|---|
| `BUNNY_STREAM_CDN_HOST`, `BUNNY_STREAM_LIBRARY_ID` | opsional | Host CDN + library id Stream |
| `BUNNY_STREAM_API_KEY` | opsional | Management API (metadata) |
| `BUNNY_REFERER` | opsional | Header Referer fetch CDN (pull zone menolak referer kosong) |
| `BUNNY_STREAM_TOKEN_KEY` | opsional | Key Token Authentication untuk signed URL (mode `signed`) |
| `MEDIA_TOKEN_SECRET` | **wajib di prod** | Key AES-256-GCM token media opaque (default dev tidak aman) |
| `MEDIA_MODE` | opsional (`proxy`) | `proxy` = backend stream bytes; `signed` = 302 ke signed URL Bunny |
| `MEDIA_TOKEN_TTL_SECONDS`, `MEDIA_SIGNED_URL_TTL_SECONDS`, `MEDIA_DOWNLOAD_TTL_SECONDS`, `MEDIA_DEFAULT_RESOLUTION` | opsional | TTL token/URL + resolusi default |

### 1.11 SQS / comms relay

Koneksi saja — nama queue = konstanta kode di `mq/topology.ts`; URL queue di env karena memuat account id + region. Lokal: ElasticMQ + dummy creds; prod: kosongkan endpoint/creds → SDK pakai IAM role.

| Var | Sifat | Kegunaan |
|---|---|---|
| `SQS_REGION`, `SQS_ENDPOINT` | opsional | Region + endpoint lokal (ElasticMQ) |
| `SQS_ACCESS_KEY_ID`, `SQS_SECRET_ACCESS_KEY` | opsional | Creds lokal saja |
| `SQS_COMMS_URGENT_URL`, `SQS_COMMS_NORMAL_URL` | opsional | URL queue per prioritas; kosong = relay mode log-only |
| `COMMS_RELAY_INTERVAL_MS`, `COMMS_RELAY_BATCH_SIZE` | opsional | Pacing daemon relay |

### 1.12 Test account (OTP bypass)

Dibaca **live** dari `process.env` via `testAccountConfig()` (bisa di-flip tanpa restart). Kill-switch default OFF; whitelist **hanya akun dummy** — identifier asli di sini = password reset via `000000`. Lihat [`docs/specs/test-account.md`](../../specs/test-account.md).

| Var | Sifat | Kegunaan |
|---|---|---|
| `TEST_ACCOUNT_ENABLED` | opsional (off) | Kill-switch |
| `TEST_ACCOUNT_OTP_CODE` | opsional | Kode OTP tetap |
| `TEST_ACCOUNT_IDENTIFIERS` | opsional (CSV) | Whitelist email/phone tester |

### 1.13 Resync (deklarasi terpisah)

`apps/resync-worker/src/config.ts` — sengaja di luar `env.ts` supaya proses resync tidak menuntut env app lengkap: `RESYNC_INTERVAL_SEC`, `RESYNC_SYNCERS`, `RESYNC_BATCH_SIZE`, `RESYNC_WRITE_CONCURRENCY`, `RESYNC_WATERMARK_LAG_SEC`, `RESYNC_LEGACY_RECONNECT_RETRIES`, `RESYNC_LOCK_TTL_SEC` + kredensial `LEGACY_DB_*`. Detail: [workers.md §5](workers.md).

## 2. Runtime settings (`app_settings`)

Diakses via `settingsService.get/getNumber/getBoolean(key, fallback)` — fallback berlaku saat row belum di-seed, jadi app tetap jalan. `set()` meng-upsert + refresh cache. Key stabil di `SETTING_KEYS` (`packages/common/src/services/settings.service.ts`):

| Key | Fallback (kode) | Dipakai di |
|---|---|---|
| `affiliate.cookieDays` | 30 | `attribution.service` — window attribution last-touch |
| `affiliate.holdDays` | 7 | Job `affiliate-pending-to-balance` — hold komisi non-IAP |
| `affiliate.iapHoldDays` | 35 | Job yang sama — hold komisi channel IAP (settlement bulanan Apple/Google) |
| `disbursement.autoEnabled` | — | `disbursement.service` — routing payout AUTO vs MANUAL |
| `disbursement.autoApproveMax` | — | `disbursement.service` — batas atas self-approve AUTO |
| `disbursement.fee` | 5.000 | `quoteDisbursement` (via `getSummary` + `requestDisbursement`) |
| `disbursement.minBalance` | 15.000 | Minimum gross request payout (dua caller yang sama) |
| `kyc.minBalance` | 0 (off; seeded 55.000) | `assertBalanceForKyc` — gate saldo sebelum boleh KYC (Didit & manual) |
| `subscription.graceDays` | 7 | `subscription.service` — hitung `graceUntil` saat aktivasi/renewal |
| `subscription.reminderDaysBefore` | `7,3,1` | Job `subscription-renewal-reminder` — bucket H-berapa saja |

> Cache TTL 30 detik per proses — perubahan row DB efektif di semua proses dalam ≤ 30s. Untuk paksa segera (mis. di test): `SettingsService.clearCache()`.

## Referensi

- `packages/common/src/config/env.ts` — sumber kebenaran env (komentar per var rinci)
- `packages/common/src/services/settings.service.ts` — SettingsService + SETTING_KEYS
- Seeds `app_settings`: `prisma/seeds/`
- Proses yang mengonsumsi konfigurasi ini: [workers.md](workers.md)
