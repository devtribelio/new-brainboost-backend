# Spec: Listening Tracker (Streak, Sesi, Total Dengerin, Challenge, Rekap)

Status: FINAL (keputusan inti terkunci di §8) — siap di-`/spec:decompose`
Owner: product@tribelio.com
Repos: `brainboost-apps` (Flutter), `new-brainboost-backend` (Express + Prisma + Postgres)
Tanggal: 2026-06-23

---

## 1. Tujuan & Konteks

Beranda menampilkan metrik aktivitas dengar user: **Streak**, **Sesi Diputar**, **Total Dengerin**, progress per-program ("Hari 7 dari 90"), **30-Day Challenge**, dan **Rekap Mingguan**. Saat ini angka-angka itu belum punya sumber data authoritative.

**Keputusan arsitektur (sudah final):** dibangun sebagai **first-party tracker** di backend sendiri — BUKAN dari analytics SDK (Firebase/AppsFlyer/Clarity) yang sudah terpasang. Alasannya: ini **fitur produk** (authoritative, real-time, per-user, cross-device, nyambung ke gamifikasi komisi), sedangkan analytics SDK itu pipe satu-arah ke dashboard tim dengan latency jam-jaman dan tak bisa dibaca-balik per-user.

**Prinsip:** lean. 1 tabel inti + 2 endpoint. Angka diturunkan (computed), bukan disimpan berlebihan. Tidak bikin tabel Streak/Recap terpisah di MVP.

## 2. Yang Sudah Ada (reuse, jangan bikin ulang)

**Mobile:**
- `lib/core/service/tracker/tracker_service.dart` — sudah emit `bb_play_start`, `bb_pause_start`, `bb_audio_completed`; enricher sudah lampirin `memberId`, `device_id`, `version_app`, `source`. → tinggal tambah **satu sink** ke backend.
- `lib/shared/function/audio_player_handler.dart` — `just_audio`; punya `positionStream` & `processingStateStream` (deteksi selesai).
- SQLite `tbl_audio_progress` (`database_helper.dart`) — posisi per-audio sudah tersimpan → progress bar "14 menit tersisa" datanya sudah ada.
- Network: Retrofit + Dio di `lib/core/network/remote/`.

**Backend:**
- Prisma 5 + Postgres, schema `prisma/schema.prisma`.
- Pola agregasi: `apps/mobile-api/src/modules/commission/commission.service.ts` (`prisma.aggregate`/`groupBy`).
- Cron: `apps/mobile-api/src/jobs-runner.ts` (+ contoh `affiliate-pending-to-balance.ts`).
- `CourseEnrollment` sudah ada (`progress` float, `dateStart`) → dipakai untuk challenge day & progress kursus.

## 3. Scope

**In-scope (MVP):**
- Capture sesi dengar dari mobile → backend.
- `GET /api/user/stats/home` mengembalikan: streak, sesi diputar, total dengerin, challenge per-program, rekap minggu berjalan.
- Render di Beranda.

**Out-of-scope (MVP):**
- Materialized view / pre-aggregation cron (tambah hanya bila read-time lambat).
- Analytics warehouse pihak ketiga (Mixpanel/Amplitude).
- Badge/leaderboard sosial.

## 4. Data Model (backend — 1 tabel inti)

```prisma
model ListeningSession {
  id              String   @id @default(uuid()) @db.Uuid
  clientSessionId String   @map("client_session_id")   // UUID dari device → idempotency
  memberId        String   @map("member_id") @db.Uuid
  audioId         String   @map("audio_id") @db.Uuid
  courseId        String?  @map("course_id") @db.Uuid
  startedAt       DateTime @map("started_at")           // UTC
  listenedSec     Int      @map("listened_sec")         // detik benar-benar didengar (bukan durasi audio)
  completed       Boolean  @default(false)
  localDay        DateTime @map("local_day") @db.Date   // tanggal WIB saat write → streak query trivial
  source          String?                               // ios/android
  createdAt       DateTime @default(now()) @map("created_at")

  @@unique([memberId, clientSessionId])                 // dedup retry
  @@index([memberId, localDay])
  @@index([memberId, courseId, localDay])
}
```

Catatan: `localDay` dihitung saat write pakai TZ **Asia/Jakarta (WIB, UTC+7)** supaya batas hari konsisten dan query streak tinggal `DISTINCT local_day`. Progress per-audio (resume point) tetap di SQLite mobile + `CourseEnrollment.progress`; tidak diduplikasi ke tabel ini.

## 5. Kontrak API

### 5.1 `POST /api/tracking/session` (auth)
Dikirim mobile saat audio **pause/stop/selesai/app-background**. Idempotent.
```jsonc
// Request
{
  "clientSessionId": "uuid-v4",      // digenerate di device saat play mulai
  "audioId": "uuid",
  "courseId": "uuid|null",
  "startedAt": "2026-06-23T01:10:00Z",
  "listenedSec": 845,                 // akumulasi detik yang benar2 didengar
  "completed": true
}
// Response 200
{ "ok": true }
```
Server: upsert by `(memberId, clientSessionId)` — update `listenedSec`/`completed` bila sesi sama dikirim ulang (mis. pause→resume→complete). Hitung `localDay` dari `startedAt` di WIB.

### 5.2 `GET /api/user/stats/home` (auth)
```jsonc
{
  "streakDays": 7,
  "sessionsPlayed": 23,                 // §8: lifetime vs periode → default LIFETIME
  "totalListenSec": 22500,              // lifetime
  "challenges": [                       // per CourseEnrollment aktif; day = streak konsekutif berjalan (reset 0 bila skip)
    { "courseId": "..", "title": "Stop Smoking", "day": 7,  "target": 90 },
    { "courseId": "..", "title": "Law of Attraction", "day": 12, "target": 60 }
  ],
  "weeklyRecap": {
    "weekNumber": 2,                    // §8: basis minggu
    "daysActive": 6, "daysTarget": 7,
    "streakDays": 7, "listenSec": 22500
  }
}
```
Semua dihitung **at read-time** (Prisma `aggregate`/`groupBy` + sedikit logika streak), meniru `commission.service.ts`.

## 6. Logika Agregasi (computed, bukan disimpan)

Konstanta config: `MIN_SESSION_SEC=30` (ambang 1 sesi dihitung), `MIN_QUALIFY_SEC=600` (**10 menit/hari** biar hari itu "qualifies" untuk streak & challenge), `TZ=Asia/Jakarta`.

- **sessionsPlayed** (lifetime) = `count(ListeningSession where memberId AND listenedSec >= MIN_SESSION_SEC)`.
- **totalListenSec** (lifetime) = `sum(listenedSec)`.
- **streakDays** = **streak konsekutif ketat**. Untuk tiap hari WIB hitung `sum(listenedSec)`; hari "qualifies" bila `>= MIN_QUALIFY_SEC` (10 mnt, audio apa pun). Hitung hari berurutan mundur dari hari ini WIB (kalau hari ini belum qualify, mulai dari kemarin — belum dianggap putus sampai hari berganti). **Skip 1 hari qualify → streak balik 0.**
- **challenge[].day** (per `courseId`) = **streak konsekutif per-program**. Hari qualify bila `sum(listenedSec) >= MIN_QUALIFY_SEC` **khusus audio course itu** (filter `courseId`). Hitung hari berturut-turut; **skip sehari → balik 0.** `day` = panjang streak berjalan, `target` = durasi program (mis. 90/60/30). Kartu "30-Day Challenge" = challenge program biasa dengan `target=30` (mis. Money Magnet) — mekanik sama, bukan kasus khusus.
- **weeklyRecap** = `groupBy(local_day)` dalam window minggu berjalan → `daysActive` (hari yang qualify), `sum(listenedSec)`, plus `streakDays` saat ini.

Catatan: ambang 10 menit dievaluasi atas **total per hari**, bukan per sesi (boleh akumulasi dari beberapa sesi pendek).

## 7. Alur Mobile (capture)

1. Saat play dimulai → generate `clientSessionId` (uuid), catat `startedAt`, mulai akumulasi `listenedSec` dari `positionStream` (hitung waktu nyata terdengar, bukan posisi seek).
2. Saat pause / stop / selesai / app ke background → kirim `POST /api/tracking/session`. Reuse titik yang sama dengan event `bb_pause_start`/`bb_audio_completed` di `audio_player_handler.dart`.
3. **Offline-safe:** kalau POST gagal, simpan antrean di SQLite (tabel baru `tbl_pending_session`) → flush saat online. Idempotency `clientSessionId` mencegah dobel.
4. Tambah `StatsRemoteSource` (Retrofit) + Cubit untuk `GET /stats/home`; cache hasil ke SharedPreferences untuk render instan, lalu reconcile.

## 8. Keputusan (sudah dikonfirmasi ✅)

1. **Sesi Diputar & Total Dengerin** = **lifetime**.
2. **Streak (global)** = konsekutif WIB, qualify bila dengar **≥10 menit/hari** (audio apa pun). Skip hari → **balik 0**.
3. **Challenge "Hari N"** = **streak ketat per-program**: qualify bila **≥10 menit/hari khusus audio program itu**. Skip hari → **balik 0**. `target` = durasi program.
4. **30-Day Challenge (kartu)** = challenge program biasa dengan `target=30`. Bukan kasus khusus — unify dengan §6.
5. **Ambang qualify** = **10 menit**, dihitung dari total per hari.

### Sisa minor (default dipakai, low-risk — boleh dikoreksi nanti):
- **Rekap Minggu ke-N** — default: minggu sejak member `createdAt` (WIB, mulai Senin). "Minggu ke-2" = minggu kedua sejak join.
- **Definisi "audio selesai"** (`completed`) — default: event `processingState.completed` dari `just_audio` **atau** posisi ≥95% durasi.

## 9. Phasing

- **P0 (MVP):** tabel `ListeningSession` + migration, `POST /tracking/session`, `GET /stats/home` (streak + sesi + total + weekly), mobile capture + antrean offline, render Beranda. Streak/recap at read-time.
- **P1:** challenge per-program di kartu Program Aktif; rekap mingguan share-able ("Tap untuk lihat & bagikan").
- **P2:** cron pre-aggregation bila read-time melambat; dorong event ke RabbitMQ untuk konsumer analitik internal.

## 10. Risiko

- **Timezone bug** (batas hari streak) → mitigasi: simpan `localDay` WIB saat write.
- **Inflasi listenedSec** (user diam/seek) → hitung waktu nyata dari `positionStream`, bukan delta seek.
- **Dobel kirim** → idempotency `clientSessionId`.
- **Beban read** "/stats/home" tiap buka Beranda → index `(memberId, localDay)`; cache klien; P2 pre-agg bila perlu.
```
