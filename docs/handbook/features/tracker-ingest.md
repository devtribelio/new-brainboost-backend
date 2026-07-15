# Listening Tracker & Purchase Ingest

[⬅ Kembali ke index](../README.md)

## Overview

Dua fitur kecil yang berdiri sendiri tapi sama-sama bertipe "pintu masuk data":

1. **Listening Tracker** — mobile player melaporkan sesi dengar ke log append-only `listening_session`; semua metrik home-screen (streak, sesi diputar, total dengerin, challenge per program, rekap mingguan) **dihitung saat read** dari log itu — tidak ada tabel pre-agregasi di MVP.
2. **Purchase Ingest** — pintu masuk pembelian dari kanal pihak ketiga (IAP/RevenueCat, Scalev, Lynk.id) lewat satu endpoint ber-API-key. Berbagi tabel & jalur side-effect yang sama dengan [commerce](commerce.md), termasuk komisi affiliate idempoten.

- Kode: `apps/mobile-api/src/modules/tracker/` (`tracking.*` = ingest sesi, `stats.*` = metrik) dan `apps/mobile-api/src/modules/ingest/`
- Spec desain: [`docs/specs/brainboost-tracker-spec.md`](../../specs/brainboost-tracker-spec.md) · [`docs/specs/external-purchase-webhook.md`](../../specs/external-purchase-webhook.md)

## Endpoint

| Method | Path | Auth | Deskripsi |
|---|---|---|---|
| POST | `/api/tracking/session` | JWT | Lapor sesi dengar (dikirim saat pause/stop/selesai/app-background). Idempoten — upsert by `(memberId, clientSessionId)`; kiriman ulang sesi yang sama meng-update `listenedSec`/`completed` |
| GET | `/api/user/stats/home` | JWT | Semua metrik home-screen sekali fetch: `streakDays`, `sessionsPlayed`, `totalListenSec`, `challenges[]` (day/target per course), `weeklyRecap` |
| POST | `/api/ingest/purchase` | API key (`credentialGuard`) | Ingest pembelian pihak ketiga → buat/settle `CommerceTransaction` + side effects. **Bukan** auth member |

Catatan prefix: tracker sengaja terpecah dua modul — ingest di `/api/tracking/*`, baca metrik di `/api/user/*` (mengikuti kontrak mobile).

## Tabel database

| Tabel | Peran di fitur ini |
|---|---|
| `listening_session` | Log sesi dengar append-only. **Tanpa FK ke Lesson/Course** by design — ingest murah tidak boleh gagal karena row lesson dihapus. `localDay` (date, WIB) dihitung saat write |
| `course_enrollment` | Sumber daftar challenge aktif (`programDays` course = `target`) |
| `third_party_credentials` | Auth ingest: API key tersimpan **hashed** (`keyHash`), master switch `isActive`, capability toggles per provider |
| `commerce_transactions` | Order hasil ingest; idempoten via unique `(provider, providerEventId)` |
| `affiliate_attribution_claims` | Guard komisi "first settle wins" per `(provider, attributionKey)` — lihat [commerce](commerce.md) |

## Business rules

### Tracker

1. **Idempotensi ingest** — `clientSessionId` (UUID yang digenerate device saat play mulai) + unique `(memberId, clientSessionId)`: retry offline-queue mobile tidak pernah dobel; kiriman ulang = update, bukan insert.
2. **Batas hari = WIB** — `localDay` dihitung dari `startedAt` dengan TZ `Asia/Jakarta` **saat write**, sehingga query streak tinggal `DISTINCT local_day`.
3. **Semua metrik computed at read-time** (`StatsService`, Prisma aggregate/groupBy) — tidak ada job/agregasi tersimpan. Konstanta: `MIN_SESSION_SEC=30` (ambang satu sesi dihitung), `MIN_QUALIFY_SEC=600` (10 menit/hari agar hari "qualify").
4. **Streak global** = hari WIB berurutan yang total dengarnya ≥ 10 menit (audio apa pun). Hari ini belum qualify → hitung mundur dari kemarin (belum dianggap putus sampai hari berganti). **Skip satu hari qualify → streak balik 0.**
5. **Challenge per program** = mekanik streak yang sama tapi difilter `courseId`; `day` = panjang streak berjalan, `target` = `programDays` course (90/60/30). Kartu "30-Day Challenge" bukan kasus khusus — hanya program dengan `target=30`.
6. **`sessionsPlayed` & `totalListenSec` = lifetime**; `weeklyRecap` = groupBy `local_day` pada minggu berjalan (minggu ke-N dihitung sejak `createdAt` member, WIB, mulai Senin).

### Ingest

1. **Auth per provider** — `credentialGuard` mencocokkan API key terhadap `keyHash` di `third_party_credentials`; provider nonaktif (`isActive=false`) ditolak.
2. **Capability toggles, default aman** — `triggersAffiliate=false` (provider tidak otomatis boleh memicu komisi) dan `canIngestRefund=false` (tidak boleh void komisi via event refund). Dinyalakan manual per provider.
3. **Idempotensi order** — unique `(provider, providerEventId)` di `commerce_transactions`: redelivery event provider → P2002 → no-op.
4. **Komisi idempoten lintas re-settle** — `AffiliateAttributionClaim` unique `(provider, attributionKey)` (mis. Apple `original_transaction_id`): settle pertama bayar komisi, re-settle berikutnya (delete+rebuy, restore, RC re-sync burst) hanya enrollment, tanpa dobel komisi. Detail di [commerce](commerce.md) & halaman affiliate.
5. Side effects (enrollment, komisi, aktivasi subscription) berjalan lewat event `commerce.payment.success` yang sama dengan jalur web — satu pipeline, banyak pintu masuk.

## Referensi

- Spec tracker (kontrak API + logika agregasi + keputusan): [`docs/specs/brainboost-tracker-spec.md`](../../specs/brainboost-tracker-spec.md)
- Desain external purchase webhook (provisioning member placeholder, DTO): [`docs/specs/external-purchase-webhook.md`](../../specs/external-purchase-webhook.md)
- Jalur commerce & event: [commerce.md](commerce.md)
- Webhook RevenueCat (subscription IAP): [subscription.md](subscription.md)
