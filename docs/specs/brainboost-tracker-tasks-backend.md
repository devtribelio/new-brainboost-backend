# Tracker — Task Backend (`new-brainboost-backend`)

Owner: Backend dev
Spec: `brainboost-tracker-spec.md` (sumber kebenaran; kontrak API = §5, logika = §6/§8)
Boundary: implementasikan **persis** kontrak §5 supaya mobile bisa paralel pakai mock.

Stack: Express + Prisma 5 + Postgres + TypeScript. Pola yang dicontek:
`apps/mobile-api/src/modules/commission/commission.service.ts` (aggregate/groupBy),
`apps/mobile-api/src/modules/post/post.controller.ts` (controller+route).

---

## Urutan & dependensi
B1 → B2 → (B3 ∥ B4) → B5. B6 nempel di B3/B4. B7 paralel kapan saja.

### B1. Model + migration `ListeningSession`
- Tambah model di `prisma/schema.prisma` (lihat spec §4).
- `npx prisma migrate dev --name add_listening_session`.
- **DoD:** migration up/down jalan; index `(member_id, local_day)` & `(member_id, course_id, local_day)` ada; unique `(member_id, client_session_id)` ada.

### B2. Util waktu (WIB) + konstanta
- Helper `toLocalDayWIB(startedAt: Date): Date` (potong ke tanggal Asia/Jakarta, UTC+7).
- Config konstanta: `MIN_SESSION_SEC=30`, `MIN_QUALIFY_SEC=600`, `TZ=Asia/Jakarta`.
- **DoD:** unit test boundary (23:30 WIB vs 00:30 WIB jatuh ke tanggal benar).

### B3. `POST /api/tracking/session` (auth)
- DTO + validasi: `clientSessionId`, `audioId`, `courseId?`, `startedAt`, `listenedSec`, `completed`.
- Service: **upsert** by `(memberId, clientSessionId)`; isi `localDay` dari B2; `memberId`/`source` dari auth context.
- Idempotent: kirim ulang sesi sama → update `listenedSec`/`completed`, bukan baris baru.
- **DoD:** kirim 2× payload sama → tetap 1 baris; field terupdate; response `{ok:true}`; ditolak tanpa auth.

### B4. `GET /api/user/stats/home` (auth) — agregasi read-time
- **sessionsPlayed** = count (`listenedSec >= MIN_SESSION_SEC`), lifetime.
- **totalListenSec** = sum, lifetime.
- **streakDays** (global) = konsekutif WIB, hari qualify bila Σ`listenedSec`/hari `>= MIN_QUALIFY_SEC`; skip → 0. (Hari ini belum qualify ≠ putus sampai ganti hari.)
- **challenges[]** per `CourseEnrollment` aktif = streak konsekutif **khusus course itu** (Σ harian per `courseId >= MIN_QUALIFY_SEC`); skip → 0; `target` = durasi program; kartu 30-day = `target:30`.
- **weeklyRecap** = `groupBy(local_day)` window minggu berjalan → `daysActive`, `listenSec`, `streakDays`; `weekNumber` = minggu sejak member `createdAt` (default §8).
- **DoD:** bentuk response = spec §5.2; angka cocok dengan data seed uji.

### B5. Helper streak (unit-tested, terpisah)
- `computeStreak(daysWithQualifyingSec: Date[]): number` dipakai global & per-program.
- **DoD test:** (a) hari berurutan → benar; (b) ada gap → reset; (c) belum dengar hari ini tapi kemarin qualify → streak tetap (belum putus); (d) zona waktu batas tengah malam WIB.

### B6. Routing + auth wiring
- Daftarkan route di modul mobile-api (ikuti pola controller `post`); pasang auth middleware yang sama.
- **DoD:** route muncul; auth enforced; smoke test via curl/Postman.

### B7. Seed/fixtures + dokumentasi kontrak
- Skrip seed sesi contoh (1 user, beberapa hari, 2 program) untuk uji manual & demo mobile.
- Pasang contoh request/response di README modul (samakan dgn spec §5).
- **DoD:** mobile dev bisa hit endpoint di **staging** dengan data realistis.

---

## Catatan
- **Belum** perlu cron/RabbitMQ (itu P2 — hanya kalau read-time lambat). Jangan over-build.
- Deploy ke **staging-backend** dulu (lihat infra catatan tim) supaya mobile bisa integrasi.
- Jangan sentuh resume-point per-audio (itu tetap di SQLite mobile + `CourseEnrollment.progress`).
