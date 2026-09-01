# Listening Tracker & Streak — insiden, perbaikan, dan desain ulang

**Status:** analisis selesai · keputusan produk menunggu (§7) · **Tanggal:** 2026-08-28
**Repo:** `new-brainboost-backend` (BE), `brainboost-apps` (mobile), `backoffice-bb` (ops)
**Menggantikan:** `docs/tracker-lost-sessions-incident.md` (digabung ke sini)

Dokumen ini satu paket: (1) konteks pemakaian app, (2) insiden sesi hilang Agu 2026 + cara cek + backfill + prevent, (3) masalah batas hari untuk pendengar sebelum tidur, (4) desain ulang streak 3-state ala TikTok, (5) urutan rollout.

---

## 1. Konteks produk: ini app yang diputar sebelum tidur

Brainboost adalah audio afirmasi/subliminal yang **sengaja diputar menjelang tidur**. Data prod 14 hari terakhir (14–28 Agu 2026, sesi ≥30 dtk, dibobot menit dengar):

| Jam mulai (WIB) | % menit dengar |
|---|---|
| 20:00 | 3,3 |
| 21:00 | 8,5 |
| 22:00 | 13,8 |
| **23:00** | **14,7** ← puncak |
| **00:00** | **13,3** |
| 01:00 | 9,6 |
| 02:00 | 6,6 |
| 03:00 | 5,4 |
| 04:00–19:00 | 24,8 (semua jam lain digabung) |

- **72% menit dengar terjadi antara 21:00 dan 03:59.**
- **12,8% sesi yang qualify (≥10 mnt) melewati tengah malam** — 6.490 sesi dari 2.985 member dalam 14 hari.
- Satu audio penuh ≈ 61 menit; user biasanya menyalakan, mengunci layar, lalu tertidur.

Implikasi: setiap aturan yang memakai **00:00 sebagai batas hari** memotong tepat di puncak pemakaian. Pola "dengar tiap malam" yang konsisten bisa terbaca sebagai "bolong" hanya karena satu malam mulai jam 23:50 dan malam berikutnya jam 00:10.

## 2. Aturan streak saat ini (ringkas)

Spec: `brainboost-apps/docs/brainboost-tracker-spec.md`. Implementasi: `apps/mobile-api/src/modules/tracker/`.

- Satu tabel `listening_session` (`started_at`, `listened_sec`, `local_day`, `audio_id`, `course_id`, `completed`, `source`). `local_day = toLocalDayWIB(startedAt)` — **seluruh sesi dikredit ke tanggal mulai**, tidak dipecah.
- Hari **qualify** bila `SUM(listened_sec)` hari itu ≥ `MIN_QUALIFY_SEC` = **600** (10 menit), audio apa pun. Sesi dihitung bila ≥ `MIN_SESSION_SEC` = 30.
- **Streak** = hari qualify berurutan mundur dari hari ini WIB; hari ini belum qualify → mulai dari kemarin (belum putus sampai hari berganti). **Skip 1 hari → 0.** Tidak ada freeze/grace.
- **Challenge per program** = streak yang sama tapi difilter `course_id`; `target` = durasi program.
- Semua **dihitung saat baca** (`GET /api/user/stats/home`, `computeStreak` di `tracker.streak.ts`). Tidak ada streak tersimpan, tidak ada cron.
- Client (`audio_player_handler.dart` + `listening_session_sync.dart`) mengirim sesi hanya pada **checkpoint**: pause / stop / selesai / app ke background / task di-swipe. Antrean offline di SQLite `tbl_pending_session`, upsert idempoten per `clientSessionId`.

---

## 3. Insiden Agu 2026: sesi hilang → streak putus "setelah update"

### 3.1 Gejala

Member melapor streak 0 setelah update app padahal mendengarkan; Firebase (`bb_play_start`/`bb_pause_start`) merekam sesi >10 menit, `listening_session` tidak. Contoh: `gifuzna@gmail.com` (6→0 di 27 Agu), `lazulda95@gmail.com` (6→0 di 26 Agu), `ataner1073@gmail.com` (5→0 di 26 Agu). Tidak ada spike global: sesi mikro <30 dtk stabil 15–19 % per hari.

### 3.2 Akar masalah (mobile)

`lib/shared/function/audio_player_handler.dart`:

```dart
bool get _isLoggedIn => dataStore.getProfile() != null;   // L98 — gerbang = cache PROFIL, bukan token
...
void _finalizeSession(...) {
  if (!_isLoggedIn) { _clearSession(); return; }            // L423 — sesi DIBUANG, tidak di-enqueue
```

Bila cache profil kosong sementara token ada, app tampak login (boot ke `/main`, audio jalan, Firebase merekam karena `identify(memberId)` sudah dipanggil), tetapi **setiap checkpoint dibuang diam-diam**. Kondisi ini nyata — commit `e14cbdfc` (2026-08-19, `develop`, **belum rilis**): *"listening tracking read isLoggedIn false from the same cache"*. Update app adalah pemicu yang masuk akal untuk mengosongkan cache profil. Rilis terakhir `main`: v3.3.0 (14 Agu).

Pemberat: tidak ada checkpoint berkala selama play (proses mati mendadak = menit hilang); `listening_session.source` tidak pernah diisi (tidak ada versi app → klaim "karena update" tidak bisa dibuktikan dari data).

Catatan teknis: `local_day` dihitung dari `startedAt` kiriman HP, jadi flush antrean yang telat tetap masuk hari yang benar. Ditemukan 1 baris `local_day = 2026-08-30` (jam HP salah) — perlu ditolak di BE.

### 3.3 Cek: siapa lagi yang kena

Backend tidak bisa melihat sesi yang dibuang → **kandidat dari backend, verifikasi di Firebase**.

**(a) Kandidat** — member dengan satu hari kosong di antara dua hari qualify:

```sql
WITH d AS (
  SELECT member_id, local_day, SUM(listened_sec) >= 600 AS q
  FROM listening_session WHERE local_day >= CURRENT_DATE - 21 GROUP BY 1, 2
), q AS (SELECT member_id, local_day FROM d WHERE q)
SELECT a.member_id, m.email, m.full_name, a.local_day + 1 AS hari_putus
FROM q a JOIN q b ON b.member_id = a.member_id AND b.local_day = a.local_day + 2
JOIN members m ON m.id = a.member_id
WHERE NOT EXISTS (SELECT 1 FROM q x WHERE x.member_id = a.member_id AND x.local_day = a.local_day + 1)
ORDER BY hari_putus DESC, m.email;
```

21 hari terakhir: **7.588 hari-putus dari 3.759 member**. Untuk 26 Agu saja: 353 member. Ini kandidat, bukan bukti.

**(b) Verifikasi di Firebase** — export GA4 aktif: dataset **`tribelio.analytics_201961759`**, tabel `events_YYYYMMDD` (query lengkap di Lampiran A). `bb_pause_start` membawa `media_id`, `product_code`, `duration_sec`, `position_sec`, `total_sec`. Per member per hari: `firebase_sec = SUM(duration_sec)`; **terdampak** bila `firebase_sec ≥ 600` dan `backend_sec < 600`. Pakai `paused_at − duration_sec` sebagai waktu mulai (konsisten dengan "kredit ke tanggal mulai").

Cara memetakan event ke member (dipelajari 2026-08-28, semuanya penting):
- `user_id` Firebase = `memberId` dari profil: **UUID `members.id` sejak app 3.2.3**, **`legacy_id` (angka) di ≤3.2.2**. Satu member bisa punya dua `user_id` — petakan dua arah.
- Setiap event juga membawa `event_params` **`email`** dan **`memberId`** (dari `TrackerEventEnricher`) — jalur kedua bila `user_id` NULL.
- `event_params.device_id` = **Android Build ID** (mis. `BP2A.250605.031`), dipakai bersama oleh ribuan HP. **Bukan** identitas device; jangan dipakai untuk join. (Tiket mobile: ganti dengan Firebase Installation ID.)
- Tabel turunan `tribelio.data_analytics.start_and_pause` **tidak boleh dipakai**: hanya 72 member (kolom `memberId INT64` membuang UUID), tidak lengkap bahkan untuk member ber-legacy_id, dan bercampur pengguna app lama.
- Sidik jari sesi (waktu selesai + produk + durasi) hanya untuk event ber-`user_id` NULL, toleransi ≤90 dtk / ≤30 dtk, **≥2 kecocokan**, dan pseudo id belum terpetakan ke member lain — di jam tidur, banyak orang menyelesaikan audio yang sama pada menit yang sama.
- **Blind spot permanen:** HP dengan Private DNS / ad-blocker (AdGuard, NextDNS) tidak pernah mengirim ke Firebase walau Play Services aktif dan backend menerima sesinya (kasus `ataner1073@gmail.com`: 0 event sejak Juni). Firebase **bukan** sumber kebenaran; deteksi dari Firebase selalu punya sisa yang tidak terverifikasi → §3.6.
- Rollout **3.3.1 dimulai 27 Agu** (event pertama `event_date 20260827`). Streak yang putus 26 Agu tidak mungkin disebabkan update ke 3.3.1.

### 3.6 Kebijakan untuk laporan yang tidak bisa diverifikasi

Bukti internal yang tidak bergantung pada Firebase: `members.last_active_at`, `devices.last_seen_at`, log request (`requestLogger` → CloudWatch, ada `userId` + `route`; panggilan `/media/hls` / `/media/download` = app meminta audio), dan baris `listening_session` <10 menit di hari itu (sesi dimulai, tidak pernah difinalisasi = pola "app mati di tengah").

| Kondisi | Tindakan |
|---|---|
| Firebase membuktikan ≥10 menit | Backfill sesi sungguhan, `source='backfill:firebase:<periode>'` |
| Tidak ada Firebase, **ada** bukti internal (aktif di jam biasa / sesi mikro / request media) **dan** hari kosong hanya satu di antara dua hari qualify | **Restore goodwill**: satu baris sintetis 600 dtk, `source='goodwill:report:<tiket>'`, maks **1× per member per 30 hari** |
| Tidak ada bukti apa pun, atau bolong ≥2 hari | Tidak di-restore; balas dengan empati + jelaskan aturan |

`source` eksplisit → semua restore bisa diaudit/dicabut; batas 1×/30 hari mencegah jadi celah. Setelah §4–§5 jalan, kasus bolong satu hari termaafkan otomatis dan kebijakan ini praktis tidak terpakai.

### 3.4 Backfill

Streak tidak disimpan → **backfill = insert baris `listening_session`**; streak/challenge/rekap otomatis benar.

Script `scripts/backfill-listening-sessions.ts` (`pnpm tracker:backfill <csv> [--dry-run] [--source=...]`). **Terimplementasi 2026-08-28.**

- **Input CSV = kolom query A1 apa adanya** (Lampiran A menang atas draf kolom lama di dok ini): `firebase_user_id`, `param_member_id`, `param_email`, `started_at_utc`, `listened_sec`, `audio_id`, `product_code`, `position_sec`, `total_sec`. Pemetaan identitas dilakukan di Postgres — UUID → `members.id`, angka → `legacy_id`, lalu `param_email` → `email`; satu member yang muncul di bawah tiga kunci berbeda tetap satu member. Timestamp menerima format ekspor BigQuery (`2026-08-26 16:48:00 UTC`) maupun ISO.
- **Unit perbaikan = HARI, bukan span** — mengikuti definisi "terdampak" di §3.3b. Per (member, hari dengar): hari yang di backend sudah ≥600 dtk **dilewati** (tidak pernah putus; ini juga yang bikin run kedua jadi no-op), dan hari yang di Firebase sendiri <600 dtk juga dilewati (tidak membuktikan 10 menit; menyisipkannya cuma menggelembungkan total lifetime tanpa pernah memperbaiki streak).
- **Span yang tumpang-tindih baris asli DIKURANGI, bukan dibuang.** Kasus terdampak yang khas justru "app sempat finalisasi sekali lalu sisanya dibuang", jadi ada baris asli parsial dengan `clientSessionId` berbeda. Yang disisipkan = kekurangannya (`listened_sec − detik baris yang tumpang-tindih`, toleransi ±90 dtk), sehingga total hari mendarat tepat di angka Firebase, bukan dua kali. Sisa <30 dtk dilewati. Catatan: dua span yang menimpa satu baris asli yang sama akan mengurangi dua kali — arahnya konservatif (kurang, bukan lebih).
- `client_session_id` = UUID v5 deterministik dari `(member_id, started_at, audio_id)` → idempoten (unique `(member_id, client_session_id)` sudah ada), dipasang bersama `createMany({ skipDuplicates })`.
- `local_day` lewat helper yang sama dengan `tracking.service.ts` (`toListeningDayWIB`, diimpor — bukan disalin), jadi perubahan batas hari ikut otomatis.
- `course_id` dari `products.code` → `courses.id`; `completed` = `position_sec ≥ 95 % total_sec`.
- `source` default `backfill:firebase:<YYYY-MM>`, bisa dioverride `--source=`. Baris sintetis selalu bisa dibedakan/dicabut. **Baris asli tidak pernah disentuh** (hanya INSERT).
- `--dry-run` mencetak per member: hari yang pulih + streak sebelum/sesudah (`computeStreak`), lalu keluar tanpa menulis.

### 3.5 Prevent

Mobile, urutan prioritas:
1. **Gerbang tracking pakai token, bukan cache profil** — `_isLoggedIn` → `getToken() != null`; saat ragu **enqueue**, jangan `_clearSession()` (backend mengenali member dari bearer; profil tidak dibutuhkan). Ini menutup akar masalahnya.
2. **Rilis `e14cbdfc`** (repair cache profil di startup/reconnect).
3. **Heartbeat checkpoint tiap 60 detik selama play** — `_finalizeSession(uploadNow: false)` dari timer; BE sudah idempoten per `clientSessionId` → **nol perubahan BE**. App mati kapan pun, maksimal 1 menit hilang.
4. **Kirim `source`** = `"<platform>/<version>+<build>"` di `POST /tracking/session`.

Backend (kecil):
5. Tolak `startedAt` > sekarang + 5 menit (jam HP ngaco).
6. `warn` bila `now − startedAt > 24 h` (flush antrean sangat telat).

---

## 4. Masalah batas hari: "hari dengar" harus ikut ritme tidur

### 4.1 Bukti

- Giska: sesi **26 Agu 23:48 → 00:49** (61 mnt) dikredit penuh ke 26 Agu; malam berikutnya mulai **28 Agu 00:01** → 27 Agu tinggal 6 detik → streak 6 → 0. Dia mendengarkan setiap malam.
- Lazulda & Amanda: sesi selalu mulai **00:54–04:40** (dini hari) → "hari" mereka selalu tanggal berikutnya, dan satu malam yang mulai sebelum 00:00 langsung terbaca sebagai hari kosong.
- Simulasi 21 hari: hari-putus turun dari **7.588 (batas 00:00) → 6.717 (batas 04:00)**, member terdampak 3.759 → 3.612. Batas 04:00 saja menghapus ±11 % kasus; sisanya diselesaikan §5.

### 4.2 Aturan baru: hari dengar = 04:00 → 03:59 WIB

- **Definisi:** `listeningDay(t) = toLocalDayWIB(t − 4 jam)`. Sesi mulai 27 Agu 23:59 → hari 27; mulai 28 Agu 00:30 → **tetap hari 27**; mulai 28 Agu 04:10 → hari 28.
- Seluruh sesi tetap dikredit ke **hari saat mulai** (tidak dipecah). Kombinasi "mulai" + batas 04:00 sudah menutup kasus 23:59→00:30 tanpa perlu pemecahan proporsional; pemecahan hanya menambah kompleksitas untuk kasus yang sangat jarang (sesi >4 jam melewati 04:00).
- Berlaku seragam untuk streak global, challenge per program, dan rekap mingguan (`daysActive`), dan untuk **anchor "hari ini"** di `computeStreak` — jam 02:00 WIB masih "kemarin", jadi streak tidak terlihat putus jam 00:00 saat user justru sedang mendengarkan.
- Copy UI: "Hari dengar berganti jam 04.00 pagi" di tooltip streak; push pengingat (§5.3) dikirim relatif ke batas ini.

### 4.3 Implementasi (BE saja, tanpa perubahan client)

1. `tracker.time.ts`: `toLocalDayWIB` → `toListeningDayWIB(t) = toLocalDayWIB(t − DAY_BOUNDARY_HOURS)`, konstanta `DAY_BOUNDARY_HOURS = 4` di `tracker.constants.ts`. Dipakai di `tracking.service.ts` (write) dan `stats.service.ts` (anchor hari ini).
2. **Migrasi data sekali**: `UPDATE listening_session SET local_day = (started_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Jakarta' − interval '4 hours')::date WHERE local_day <> ...` — `started_at` tersimpan penuh, jadi semua riwayat bisa dihitung ulang, tidak ada data yang hilang. ±155 k baris, jalankan di jendela sepi; index `(member_id, local_day)` sudah ada.
3. Upsert per `clientSessionId` tidak berubah. Backfill §3.4 memakai helper baru otomatis.
4. Rekap mingguan: "minggu" tetap Senin–Minggu tetapi atas hari dengar (Senin dimulai Senin 04:00).

---

## 5. Desain ulang streak: 3-state ala TikTok

### 5.1 Pembanding

| | TikTok (DM Streaks) | Snapchat | Duolingo |
|---|---|---|---|
| Peringatan | Push "about to end" | ⏳ ~4 jam sebelum habis | Push 23:00 + widget berubah muram |
| Saat terlewat | Api **abu-abu**, angka tetap tampil | Hilang | Streak Freeze (dipasang duluan, maks 2–5) terpakai otomatis, hari tampil ❄️ |
| Jendela pulih | Tombol **Restore** di chat, **48 jam**, jumlah restore terbatas & refill | Snapchat+ 1×/bulan; gratis via support ≤7 hari | Streak Repair: kerjakan lesson dalam jendela pendek / bayar gems |
| Lewat jendela | 0 | 0 | 0 |
| Dampak | — | — | klaim 2× daily retention; Friend Streak +22 % |

Pola bersama: **putus ≠ langsung 0**. Ada *terancam* → *padam* (angka disimpan, ada jalan pulang terbatas) → *reset*.

### 5.2 State machine Brainboost

Dihitung atas **hari dengar** (§4).

| State | Kondisi | Tampilan | Angka |
|---|---|---|---|
| 🔥 **Nyala** | Hari dengar ini sudah qualify | Api oranye | N |
| ⚠️ **Terancam** | Hari dengar ini belum qualify, kemarin qualify | Api oranye + label "belum aman" | N (dari kemarin) |
| 🩶 **Padam** | Kemarin **tidak** qualify, tapi ada hari qualify ≤ `GRACE_DAYS` sebelumnya, dan jendela restore belum lewat | Api abu-abu, angka **tetap tampil**, CTA "Nyalakan lagi — dengarkan 10 menit hari ini" | N (abu-abu) |
| 0 | Jendela lewat, atau tidak pernah ada streak | Api abu-abu tanpa angka | 0 |

Transisi:
- Padam → Nyala: user qualify di hari dengar ini **dalam jendela** → streak lanjut **N → N+1**; hari yang terlewat tampil ❄️/abu-abu di kalender mingguan dan **tidak** menambah hitungan.
- Padam → 0: jendela lewat tanpa qualify.
- Jendela = `GRACE_DAYS` = **1 hari dengar** (= "48 jam" versi TikTok: hari terlewat + hari pemulihan). Dua hari berturut-turut kosong → 0.

Efek pada tiga kasus insiden: semuanya putus satu hari lalu langsung dengar lagi → di model ini **tidak pernah 0**, bahkan sebelum backfill.

### 5.2b Status implementasi (2026-08-28)

**Terbangun (BE):** state machine 4 state + jendela grace + field API baru.

- `computeStreakState(qualifyingDays, todayWIB, graceDays)` di `tracker.streak.ts`; `computeStreak()` tetap ada sebagai pembungkus yang cuma mengembalikan angka.
- **Grace di-anchor ke HARI INI, bukan ke gap.** Hari kosong dimaafkan hanya bila jaraknya ≤ `graceDays` hari dengar dari hari ini. Ini bukan pilihan tuning — streak dihitung ulang dari baris mentah tiap kali dibaca dan tidak ada state tersimpan, jadi aturan relatif-gap ("maafkan setiap bolong satu hari") akan menghidupkan **seluruh** bolong satu hari sepanjang riwayat member begitu grace nyala; streak yang putus Mei balik jadi 90 hari. Aturan window ini menggantikan kebutuhan tabel `streak_restore` untuk urusan korektnes.
- Hari yang dimaafkan dikembalikan di `forgivenDays` (❄️ di kalender mingguan) dan **tidak** menambah `days`.
- `graceDays` runtime-configurable: `app_settings` key `streak.graceDays` (`SETTING_KEYS.streakGraceDays`, fallback `GRACE_DAYS_DEFAULT` = 1, di-seed 1). Berlaku untuk streak global **dan** challenge per program.
- `graceDays = 0` → `dimmed` tidak pernah tercapai dan jalannya persis seperti versi strict. Itu yang bikin kode ini bisa masuk terpisah dari keputusan produk.
- **Perlakukan perubahan nilainya sebagai saklar produk, bukan knob.** `streakDays` di root sudah dirender semua build app yang beredar, jadi flip mengubah angka yang dilihat member tanpa rilis client. Nyalakan **setelah** migrasi `local_day` dan backfill Firebase selesai, kalau tidak angkanya bergerak dua kali.

**Sengaja tidak dibangun:** tabel `streak_restore` (kebijakan A di §5.3). Yang bikin tabel itu load-bearing adalah pencegahan pengampunan retroaktif, dan itu sudah ditutup jendela today-anchored. Tabel baru layak ditambah kalau produk mau kuota yang tampil di UI — mekanismenya menumpuk, bukan mengganti.

**Belum dibangun:** push terancam/padam (§5.4).

### 5.3 Kebijakan restore — pilih satu

| | A. Gratis-terbatas (TikTok) | B. Dibayar usaha (Duolingo repair) | C. Gratis tanpa batas |
|---|---|---|---|
| Aturan | 1 restore per 7 hari streak tercapai, min 1/bulan; sisa tampil di UI | Hari pemulihan butuh **20 menit** (2× kuota) | Setiap hari-terlewat tunggal dimaafkan |
| Data baru | Tabel `streak_restore(member_id, restored_day, used_at)` | Tidak ada | Tidak ada |
| Risiko | Perlu UI kuota + copy | User harus tahu aturannya | Streak "mudah", nilai turun |
| Rekomendasi | ✅ default — paling dekat referensi & masih computed-first | Alternatif kalau mau tanpa tabel | Tidak |

Freeze ala Duolingo (item dipasang duluan) **tidak** diambil dulu: butuh inventori + ekonomi item; bisa menyusul sebagai hadiah milestone (mis. +1 restore di hari 30/60/90).

### 5.4 Notifikasi — **terimplementasi 2026-08-28**

Job `apps/mobile-api/src/modules/tracker/streak-reminder.job.ts`, didaftarkan di `jobs-runner.ts` **dan** di argv kedua lane cron (`ecosystem.config.js` + `infra/cdk/lib/bb-ecs-stack.ts`) — mendaftar di `jobs-runner.ts` saja tidak cukup, nama yang tidak ada di argv tidak pernah jalan dan tidak pernah error. Kontraknya sama dengan `topicDigest`: dipicu tick `bb-cron` per jam, job sendiri yang memutuskan apakah jam ini jamnya — jadi waktu kirim bisa digeser dari `app_settings` tanpa redeploy dan tanpa ubah PM2. Ditaruh di modul tracker, bukan `@bb/domain/jobs`, karena helper hari/streak-nya app-local dan package tidak boleh mengimpor dari app.

Copy final (title/body dipisah — Android memotong title di ~40 char, preseden `TrialStarted`):

```
streakAtRisk  title: Streak {N} hari belum aman
              body : Dengarkan 10 menit malam ini untuk menjaganya.

streakDimmed  title: Streak {N} hari kamu padam
              body : Dengarkan 10 menit malam ini untuk menyalakannya lagi.
```

Tiga rumusan dibuang, masing-masing karena alasan berbeda:

- **"10 menit lagi sebelum jam 04.00"** (draf awal dok) — "10 menit lagi" maksudnya *10 menit mendengarkan*, tapi bahasa Indonesia membacanya "10 menit dari sekarang"; dikirim jam 21.00 kalimatnya berbunyi "tinggal 10 menit menuju jam 04.00" padahal sisanya 7 jam.
- **"hari ini"** — di bawah batas 04:00 ini ambigu: member yang dengar jam 01.00 nanti mengira sudah telat, padahal masih di hari dengar yang sama.
- **"sebelum jam 04.00 dini hari"** — deadline harfiahnya memang itu, tapi menyebut jam membocorkan aturan internal yang tidak pernah disepakati member, dan tetap terbaca seperti hitung mundur saat dikirim jam 21.00.

**Tidak ada jam yang disebut.** "malam ini" adalah yang sebenarnya terjadi — ini audio pengantar tidur, jendelanya memang malam itu. Efek samping kecil yang diterima: dengar di siang hari juga qualify, tapi copy-nya bilang "malam ini"; 72 % menit dengar mulai antara 21.00–03.59, jadi ini kasus pinggiran.

- **Tidak ada push saat streak 0.** Bukan sekadar tidak berguna — itu yang bikin fitur ini terasa menghukum.
- **at_risk** butuh streak ≥ `MIN_STREAK_FOR_AT_RISK` = 3.
- **Bukan `PUSH_LIMIT_EXEMPT`** (keputusan, menyimpang dari draf "transaksional-ringan" di atas). Isi daftar exempt semuanya soal uang; member wajib dengar soal pembayaran apa pun kebiasaan pakainya. Streak itu engagement — dan member yang lupa dengar berhari-hari justru yang paling cepat melewati budget unopened-push. Meng-exempt-nya bikin push streak jadi satu-satunya yang masih berdering ke orang yang sudah berhenti buka app.
- **Tidak ada mute scope baru.** Mute sekarang cuma post/topic/network; streak tidak masuk salah satunya, jadi tidak ada cara mematikan push ini selain mematikan notifikasi app. Diterima untuk sekarang.
- Menulis baris `notifications` (lewat `createForMember`, bukan `sendPushOnly`) — itu satu-satunya jalur yang membebankan budget, dan member jadi bisa melihat alasannya di feed.
- `dedupeKey = <type>:<memberId>:<hari dengar>` → cron yang restart di jam yang sama tidak mengirim dua kali.

**Setting** (semua runtime, tanpa redeploy):

| Key | Ship | Catatan |
|---|---|---|
| `streak.atRiskEnabled` | `false` | Saklar push malam. **Ships mati** — kelas pesan keluar baru ke seluruh basis aktif |
| `streak.dimmedEnabled` | `false` | Saklar push pagi, **terpisah** dari yang atas |
| `streak.atRiskHour` | `21` | ⚠️ lihat di bawah |
| `streak.dimmedHour` | `9` | Hanya punya kandidat selama `streak.graceDays > 0`; job melewati sweep-nya kalau grace mati |

Satu saklar **per kirim**, bukan satu untuk dua-duanya: keduanya menjawab momen yang berbeda (dorongan malam vs kesempatan kedua pagi hari), jadi salah satunya harus bisa dibungkam tanpa kehilangan yang lain. Gerbangnya dicek hanya pada jamnya sendiri — mematikan yang pagi tidak membuat yang malam ikut melapor `disabled`.

Mematikan semuanya sekaligus: `UPDATE app_settings SET value='false' WHERE key LIKE 'streak.%Enabled'`.

`dimmed` punya dua jalan untuk diam: saklarnya sendiri, dan `streak.graceDays = 0` (tidak ada member yang bisa masuk state itu, jadi sweep-nya dilewati).

Opsi `memberId` pada job membatasi sapuan ke satu member — supaya kiriman sungguhan bisa diuji di produksi tanpa menembak semua orang, dan supaya tes tidak menulis notifikasi milik spec lain.

⚠️ **Jam 21.00 belum terbukti benar.** Data §1: jam 21.00 baru 8,5 % menit dengar, puncaknya 23.00. Artinya saat push dikirim, mayoritas orang yang malam itu akan dengar **belum mulai** — jadi push "belum aman" nembak hampir semua member aktif, termasuk yang 2 jam lagi dengar seperti biasa, dan orang cepat belajar mengabaikannya. Angka yang menentukan: berapa persen member yang akhirnya qualify di suatu hari sudah mulai sebelum jam 21.00. Kandidat lebih masuk akal 01.00–02.00 (sisa 2–3 jam sebelum batas), dengan risiko mengirim ke orang yang sudah tidur. Karena jamnya setting, ini digeser lewat SQL setelah datanya dilihat — tidak menahan rilis.

**Biaya query:** streak tidak disimpan, jadi "semua member streak ≥3" tidak boleh jadi `stats.home()` per member. Dua query: satu `groupBy(memberId, localDay)` atas jendela `graceDays + 1` hari terakhir untuk menyaring kandidat, lalu satu lagi atas riwayat penuh **hanya untuk kandidat** — panjang streak yang dikutip di copy butuh riwayat penuh (member bisa 200 hari).

### 5.5 Kontrak API & data

`GET /api/user/stats/home` — tambah field, tidak mengubah yang ada (client lama tetap jalan):

```jsonc
"streak": {
  "days": 6,                 // = streakDays lama, tetap ada di root untuk kompat
  "state": "burning" | "at_risk" | "dimmed" | "none",
  "restoreDeadline": "2026-08-29T03:59:59+07:00",   // hanya saat dimmed
  "restoresLeft": 1,          // kebijakan A
  "dayBoundaryHour": 4
}
```

**Terimplementasi**, dengan dua penyimpangan dari draf di atas: `restoresLeft` **tidak** dikirim (kebijakan A tidak dibangun), dan `restoreDeadline` bernilai `null` kecuali saat `dimmed` — state lain akan menampilkan hitung mundur yang tidak ada gunanya ditindaklanjuti. Bentuk final:

```jsonc
"streak": {
  "days": 6,
  "state": "burning" | "at_risk" | "dimmed" | "none",
  "restoreDeadline": "2026-08-29T03:59:59+07:00",  // null kecuali dimmed
  "dayBoundaryHour": 4
}
```

`computeStreakState(qualifyingDays, todayListeningDay, graceDays)` — pure function, tabel uji di `tests/tracker-streak.spec.ts` (termasuk kasus "gap lama tidak boleh diampuni" dan "graceDays=0 identik dengan versi strict").

Backfill §3.4 dan migrasi §4.3 **harus selesai sebelum** fitur ini tampil, supaya angka yang pertama kali dilihat user sudah benar.

---

## 6. Urutan rollout

| # | Item | Repo | Ketergantungan |
|---|---|---|---|
| 1 | Prevent 1–4 (gerbang token, rilis `e14cbdfc`, heartbeat, `source`) | mobile | — (rilis 3.3.x) |
| 2 | BE guard `startedAt` masa depan + warn flush telat | BE | — |
| 3 | Hari dengar 04:00 + migrasi `local_day` | BE | — (client tidak berubah) |
| 4 | Backfill sesi hilang dari Firebase | BE + data | #3 (pakai helper baru), verifikasi Firebase |
| 5 | Streak 3-state + restore + API field baru | BE | #3, #4, keputusan §7 |
| 6 | UI Beranda (api abu-abu, CTA, kuota restore) + copy batas hari | mobile | #5 |
| 7 | Push terancam/padam | BE (jobs) | #5 |

#1–#3 bisa jalan paralel minggu ini; #5–#7 setelah keputusan produk.

## 7. Keputusan yang dibutuhkan

1. Kebijakan restore: **A** (gratis-terbatas, direkomendasikan) / B / C.
2. `GRACE_DAYS` = 1 hari dengar (≈ 48 jam) — setuju?
3. Batas hari dengar **04:00** WIB (alternatif 03:00 / 05:00 — data §1 menunjukkan 03:00 masih 5,4 % dan 04:00 4,3 %; 04:00 adalah lembah pertama).
4. Firebase → BigQuery export aktif? Menentukan apakah §3.3b massal atau manual.
5. Apakah streak milestone (30/60/90 sama dengan durasi program) memberi hadiah restore.

## 8. Acceptance (ringkas)

- [ ] Cache profil kosong, token ada → sesi tetap masuk `listening_session`.
- [ ] App dibunuh di tengah sesi 5 mnt → BE menerima ≥4 mnt.
- [ ] `source` terisi di semua baris dari build baru.
- [ ] Sesi mulai 23:59 dan 00:30 keesokan harinya → `local_day` sama; mulai 04:10 → hari berikutnya.
- [ ] Migrasi `local_day` idempoten; streak ketiga member contoh setelah migrasi + backfill: Giska ≥7, Lazulda ≥8, Amanda ≥7.
- [ ] Streak N, satu hari kosong, qualify hari berikutnya → N+1, hari kosong tampil ❄️; dua hari kosong → 0.
- [ ] Client lama (tanpa field `streak.state`) tetap menampilkan `streakDays` yang benar.

## 8b. Bug terpisah yang ditemukan saat verifikasi (2026-08-31)

Dua-duanya **bukan** akibat perubahan batas hari — muncul identik sebelum dan sesudah migrasi pada `GET /api/user/stats/home`. Dicatat di sini karena ketemunya saat memverifikasi response ketiga member insiden, dan belum ada tempat lain yang mencatatnya.

### BUG-1 · `listening_session.course_id` berisi `products.id`, bukan `courses.id` — challenge per program selalu 0

**Gejala.** Ketiga member insiden punya streak global 10–12 tapi **setiap** `challenges[].day` bernilai `0`, di kedua skenario bucketing.

**Bukti (prod, 2026-08-31).**

```
Giska — ENROLLMENT (courses.id)      019f7ea6-71dd-…  Money Magnet
                                     019f7ea6-734e-…  Let Go of the Past
Giska — SESI (listening_session)     019f7ea6-7344-…  rows=41
                                     019f7ea6-71d4-…  rows=1
                                     → nol yang cocok di tabel `courses`
                                     → dua-duanya cocok di tabel `products`

Populasi:  total baris                171.087
           tidak cocok ke courses.id  171.087  (100 %)
           cocok ke products.id       171.084  (99,998 %)
```

**Mekanisme.** `stats.service.ts` mem-filter sesi dengan `courseId IN (enrollment.courseId)`, dan `courseEnrollment.courseId` adalah `courses.id` yang asli. Karena kolom di `listening_session` menyimpan `products.id`, join itu **tidak pernah cocok untuk siapa pun** — challenge per program menampilkan 0 sejak fitur ini hidup. Streak global tidak terpengaruh (tidak difilter `courseId`).

**Yang harus dipastikan dulu:** apakah `courseId` di `TrackSessionDto` memang dimaksud *product* id oleh klien. Kalau iya, yang salah adalah nama kolom + join-nya, bukan data yang dikirim.

**Opsi perbaikan:**

| Opsi | Konsekuensi |
|---|---|
| Klien kirim `courses.id` | butuh rilis mobile, dan 171 k baris lama tetap rusak |
| **BE resolve `products.id` → `courses.id` saat tulis** | satu lookup di `tracking.service`, plus `UPDATE` backfill 171 k baris. **Disarankan** — jalur baca tetap `groupBy` sederhana |
| BE resolve saat baca | tanpa backfill, tapi menambah join di endpoint yang dipanggil setiap buka app |

`courses.product_id` unik, jadi pemetaannya satu-satu ke dua arah — backfill-nya deterministik.

### BUG-2 · `weeklyRecap` bisa nol di pagi hari Senin

**Gejala.** Giska (diuji Senin 31 Agu): `daysActive` 1 → 0 dan `listenSec` 3568 → 0 setelah migrasi, sementara `streakDays` 12.

**Bukan kesalahan hitung.** Sesinya mulai jam 01.00 Senin, yang di batas 04.00 masuk **hari dengar Minggu** — minggu sebelumnya. Minggu berjalan memang belum punya isi.

**Konsekuensi.** Setiap Senin pagi, member yang mendengarkan lewat tengah malam melihat `streakDays: 12` bersanding dengan `daysActive: 0/7`. Benar menurut aturan, janggal kalau FE menaruh keduanya berdampingan. Perlu disampaikan ke mobile; tidak ada perubahan BE yang diusulkan.

## Lampiran A — export BigQuery untuk deteksi & backfill

Dijalankan **sekali per insiden** oleh siapa pun yang punya akses BigQuery (bukan tugas BE). Hasilnya = CSV input untuk `pnpm tracker:backfill` (§3.4). Biaya: dihitung per byte terpindai, filter `event_date` membuat rentang 9 hari hanya beberapa ratus MB (1 TB/bulan pertama gratis).

**A1. Semua span dengar (satu baris per `bb_pause_start`)** — ganti rentang `event_date`:

```sql
SELECT
  user_pseudo_id,
  user_id                                              AS firebase_user_id,   -- UUID (≥3.2.3) / legacy_id (≤3.2.2) / NULL
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'email')    AS param_email,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'memberId') AS param_member_id,
  TIMESTAMP_MICROS(event_timestamp)                    AS paused_at_utc,
  TIMESTAMP_SUB(TIMESTAMP_MICROS(event_timestamp),
                INTERVAL CAST(COALESCE(
                  (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'duration_sec'),
                  (SELECT CAST(value.string_value AS INT64) FROM UNNEST(event_params) WHERE key = 'duration_sec'),
                  0) AS INT64) SECOND)                  AS started_at_utc,
  COALESCE(
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'duration_sec'),
    (SELECT CAST(value.string_value AS INT64) FROM UNNEST(event_params) WHERE key = 'duration_sec')
  )                                                    AS listened_sec,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'media_id')     AS audio_id,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'product_code') AS product_code,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'product_name') AS product_name,
  COALESCE(
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'position_sec'),
    (SELECT CAST(value.string_value AS INT64) FROM UNNEST(event_params) WHERE key = 'position_sec')
  )                                                    AS position_sec,
  COALESCE(
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'total_sec'),
    (SELECT CAST(value.string_value AS INT64) FROM UNNEST(event_params) WHERE key = 'total_sec')
  )                                                    AS total_sec,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'recovered')    AS recovered,
  platform,
  app_info.version                                     AS app_version,
  event_timestamp                                      AS event_ts_micros
FROM `tribelio.analytics_201961759.events_*`
WHERE event_date BETWEEN '20260820' AND '20260828'
  AND event_name = 'bb_pause_start'
ORDER BY user_pseudo_id, paused_at_utc;
```

**A2. Peta pseudo id → identitas** (rentang lebih lebar, untuk event A1 yang `user_id` NULL):

```sql
SELECT user_pseudo_id, user_id,
       (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'memberId') AS param_member_id,
       MIN(event_date) AS first_seen, MAX(event_date) AS last_seen, COUNT(*) AS n
FROM `tribelio.analytics_201961759.events_*`
WHERE event_date BETWEEN '20260601' AND '20260828'
  AND (user_id IS NOT NULL OR (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'memberId') IS NOT NULL)
GROUP BY 1, 2, 3;
```

Kontrak kolom untuk script backfill = kolom A1 apa adanya; pemetaan ke `members` (UUID → `id`, angka → `legacy_id`, lalu `param_email` → `email`) dilakukan di Postgres, bukan di BigQuery.

## 9. Referensi

- `brainboost-apps/lib/shared/function/audio_player_handler.dart` — `_isLoggedIn` (L98), `_finalizeSession` (L411–460)
- `brainboost-apps/lib/core/service/tracker/listening_session_sync.dart` — antrean offline
- `brainboost-apps` commit `e14cbdfc` — recover a session that holds a token but no cached profile
- `apps/mobile-api/src/modules/tracker/{tracking.service,stats.service,tracker.streak,tracker.time,tracker.constants}.ts`
- `brainboost-apps/docs/brainboost-tracker-spec.md` — spec awal
- Referensi produk: TikTok Streaks (Distractify, TechCrunch), Snapchat Streak Rules (UniLink), Duolingo Streaks (Deconstructor of Fun)
