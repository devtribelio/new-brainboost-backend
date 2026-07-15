# Operations — Workers & Background Jobs

[⬅ Kembali ke index](../README.md)

## 1. Peta proses runtime

Selain proses API utama, ada tiga proses background. Semuanya memakai binary/kode yang sama dari monorepo — yang beda hanya entry point.

| Proses | Entry point | Pola jalan | Tugas |
|---|---|---|---|
| `mobile-api` | `apps/mobile-api/src/main.ts` | Daemon (bisa N instance) | API member-facing; FCM push dikirim **in-process** fire-and-forget (lihat §4) |
| `jobs-runner` (`bb-cron`) | `apps/mobile-api/src/jobs-runner.ts` | One-shot, dipicu scheduler | Menjalankan 5 domain job berurutan lalu exit (§2) |
| `comms-relay` | `apps/mobile-api/src/workers/comms-relay.ts` | Daemon single-instance | Poll `notification_outbox` PENDING → publish ke Amazon SQS → bb-comms (§3) |
| `resync-worker` | `apps/resync-worker/src/worker.ts` | Daemon loop | Sync inkremental legacy MariaDB → Postgres selama masa transisi (§5) |

> ℹ️ Direktori `apps/notification-worker/` saat ini **tidak berisi source** (hanya sisa `node_modules`). Push FCM tidak punya worker terpisah — jalan in-process di API. Kalau nanti dibuat worker khusus, halaman ini harus diperbarui.

Perintah dev dari repo root:

```bash
pnpm jobs           # jalankan jobs-runner sekali (semua job)
pnpm relay:comms    # daemon relay outbox → SQS
pnpm resync:worker  # daemon resync loop
```

## 2. jobs-runner (`pnpm jobs`)

Satu proses terjadwal yang menjalankan **semua job sekali, berurutan, lalu exit** (exit 0 = semua dicoba, error per-job hanya di-log; exit 1 = fatal, mis. DB tak terjangkau). Trigger sengaja dipisah dari kode: hari ini PM2 `cron_restart` (proses `bb-cron`), nanti bisa EventBridge → ECS RunTask tanpa ubah kode. **Jangan pernah dijalankan di dalam API** — API boleh scale ke N instance, runner harus tetap satu supaya job fire tepat sekali.

Urutan job **disengaja dan tidak boleh diacak**:

| # | Job | Apa yang dilakukan | Guard idempoten |
|---|---|---|---|
| 1 | `affiliate-pending-to-balance` | Promosi komisi `PENDING → BALANCE` yang lewat hold window. Dua batch per run: channel IAP (default 35 hari, setting `affiliate.iapHoldDays`) dan channel lain/NULL (default 7 hari, setting `affiliate.holdDays`) | `updateMany` ber-guard status PENDING — run ulang tidak mempromosi dua kali |
| 2 | `execute-approved-disbursements` | Kirim payout `PENDING + approved_at IS NOT NULL` ke Xendit: baris MANUAL yang di-approve backoffice + baris AUTO yang gagal terkirim karena proses mati (self-heal). **KYC di-re-check di sini** — member non-APPROVED → baris FAILED (saldo bebas lagi) | Baris yang sudah pindah dari PENDING tak terpilih lagi; `X-IDEMPOTENCY-KEY` (= `externalId`) membentengi double-call di sisi Xendit |
| 3 | `expire-pending-payments` | Payment PENDING lewat `expiredAt` → EXPIRED (+ lepas `activeSlotTxId`, transaksi ikut EXPIRED, tulis `commerce_payment_events`, emit `commerce.payment.expired`) | Transisi per-row dalam transaksi |
| 4 | `subscription-expire` | Subscription ACTIVE dengan `coalesce(graceUntil, expiresAt) < now` → EXPIRED + emit `subscription.expired`. Enrollment lazy mati sendiri via `expired_date` — tanpa cleanup | `updateMany` ber-guard status ACTIVE — flip & event tepat sekali walau race |
| 5 | `subscription-renewal-reminder` | Reminder H-7/H-3/H-1 (bucket dari setting `subscription.reminderDaysBefore`, diproses **terkecil dulu** — sub yang baru terlihat di H-1 dapat 1 reminder, bukan seluruh tangga). Email via outbox + notifikasi in-app | Insert-first ke `subscription_reminder_logs` (unique sub+expiresAt+daysBefore); renewal memindah `expiresAt` → siklus baru re-arm otomatis |

Dua urutan yang sakral:

- **#1 sebelum #2** — payout yang di-approve tick ini melihat state saldo yang segar.
- **#4 sebelum #5** — sub yang mati lewat grace tidak boleh menerima reminder di tick yang sama.

> ⚠️ Job #5 jangan diaktifkan di prod sebelum template `SubscriptionRenewalReminder` ada di bb-comms — row outbox-nya akan gagal di sisi bb-comms.

## 3. comms-relay (`pnpm relay:comms`)

Daemon yang menuntaskan pola **transactional outbox**: producer menulis row `notification_outbox` dalam transaksi yang sama dengan mutasi domain; relay mem-poll row PENDING (interval `COMMS_RELAY_INTERVAL_MS`, batch `COMMS_RELAY_BATCH_SIZE`) dan mem-publish ke **Amazon SQS** (dua queue: urgent/normal; lokal = ElasticMQ). bb-comms mengonsumsi dan mengirim email/WA/SMS. Hasil: at-least-once tanpa dual-write race; idempotensi downstream dijaga bb-comms via `comms_idempotency` (message id = row id outbox).

Single-instance by design (claim = flip PENDING→SENT polos). Kalau butuh multi-instance, claim harus diganti `SELECT … FOR UPDATE SKIP LOCKED` — tertulis di header file-nya. Queue URL kosong = mode dev log-only. Lihat [ADR-0002](../../adr/) + [`docs/specs/email-scope.md`](../../specs/email-scope.md).

## 4. FCM push (in-process, bukan worker)

`FcmService` (`packages/domain/src/notification/fcm.service.ts`) dipanggil `NotificationProducer` secara **fire-and-forget** setiap notifikasi in-app dibuat: kirim ke token device member via FCM HTTP v1 (service account dari `FCM_SERVICE_ACCOUNT_JSON`). Tanpa kredensial → service disable diam-diam (log saja) — API tetap jalan. Detail port: [`docs/specs/notification-port.md`](../../specs/notification-port.md).

## 5. resync-worker — sync legacy (tool transisi)

> ⚠️ **Throwaway.** Hanya untuk masa transisi selagi legacy MariaDB masih ditulisi. Setelah cutover: hapus `apps/resync-worker/` + script `resync*` di root `package.json`. Spec penuh: [`docs/specs/legacy-resync-plan.md`](../../specs/legacy-resync-plan.md).

Menjaga data hasil migrasi tetap segar secara **inkremental** (`WHERE COALESCE(updated, created) > watermark`) — menangkap insert, edit, dan soft-delete dalam satu pass. 7 syncer jalan dalam urutan dependensi:

```
members → enrollments → kyc → tree → commissions → reviews → posts
                                        (posts mencakup comments/replies/likes)
```

Mekanika kunci:

| Mekanisme | Detail |
|---|---|
| Watermark + overlap | Watermark per-syncer di tabel `sync_state`; run berikutnya mundur `RESYNC_WATERMARK_LAG_SEC` (default 60s) — menutup race boundary-second & row legacy yang `updated`-nya mendahului COMMIT |
| Run-lock | Row TTL `__lock__` di `sync_state` (bukan pg advisory lock), heartbeat-refresh per syncer; proses mati → lock kedaluwarsa sendiri (`RESYNC_LOCK_TTL_SEC`, default 2× interval) |
| New-wins-on-touch (members) | Hanya field profil yang ditimpa, dan hanya bila `updatedAt <= legacySyncedAt` — tulisan app di Postgres tidak dikalahkan legacy; deaktivasi legacy selalu diteruskan |
| Commissions | Hanya menyentuh row `status=MIGRATED`; `is_expired=1` → VOIDED |
| Timezone | DATETIME legacy = wall-clock WIB; koneksi mysql2 (`timezone:'+07:00'`) mengonversi dua arah → Postgres menyimpan UTC |
| Resiliensi | Reconnect + retry ECONNRESET (`RESYNC_LEGACY_RECONNECT_RETRIES`, default 3); koneksi dibuka-tutup per tick |
| Konkurensi | Write loop paralel (`RESYNC_WRITE_CONCURRENCY`, default 10) |
| Backfill | Akhir run: re-scan kyc/tree/commissions/likes sejak epoch untuk member yang baru dimaterialisasi run itu |

Perintah (repo root):

```bash
pnpm resync [syncer...] [--dry-run] [--since=]   # one-shot CLI
pnpm resync:worker                               # loop; interval RESYNC_INTERVAL_SEC (default 3600)
pnpm resync:unlock                               # bersihkan run-lock yang nyangkut
pnpm resync:seed-redirect                        # impor member-redirect.json → tabel (sekali)
pnpm resync:fix-dates                            # koreksi tz row pra-fix 2026-07-08 (sekali)
pnpm resync:recount / resync:reset-watermark     # utilitas perbaikan counter / watermark
```

## Referensi

- Job sources: `packages/domain/src/jobs/*.ts` (tiap file punya doc-comment desain yang rinci)
- [`docs/specs/legacy-resync-plan.md`](../../specs/legacy-resync-plan.md) — desain + business rules resync
- [`docs/specs/notification-port.md`](../../specs/notification-port.md) — arsitektur notifikasi + FCM
- Konfigurasi semua proses: [environment.md](environment.md)
