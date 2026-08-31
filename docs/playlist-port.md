# Playlist + audio penyisip (BB-125 / PRD §7) — desain

Status: **DESAIN** (jalur B batch Juli 2026 — belum dikoding).
Ref: PRD Batch Juli 2026 §7 + §8 — https://tribelio.atlassian.net/wiki/x/AYAVLw
Ringkasan keputusan juga dikirim sebagai comment di BB-125 (2026-08-21).

PRD asli mengunci "kurasi internal dulu, tanpa playlist buatan user" dan menunda share.
**Keputusan 2026-08-21 membalik itu: playlist adalah fitur UGC untuk subscriber — semua
playlist dibuat member, tidak ada playlist kurasi sama sekali.** Share, copy, dan riwayat
menyusul di tahap berikutnya, tapi skema V1 sudah menampungnya (kolom nullable) supaya
tahap berikutnya aditif, bukan bermigrasi.

Konsekuensi langsung yang bagus: pertanyaan "siapa yang menyusun playlist kurasi dan lewat
UI mana" **hilang** — tidak ada UI admin di repo ini (`apps/admin-ejs` dihapus Juli 2026),
dan sekarang memang tidak dibutuhkan.

Konsekuensi yang harus ditangani produk/FE: **tab Playlist kosong untuk member baru.** Tidak
ada konten bawaan yang menjelaskan fitur ini. Empty state harus mengajari, bukan sekadar
"belum ada playlist" — misalnya langsung menawarkan "Buat dari audio yang terakhir kamu
dengar".

---

## 1. Potongan yang sudah ada (dipakai ulang, jangan dibangun ulang)

| Hal | Di mana |
|---|---|
| Satuan audio = `Lesson` | `prisma/schema.prisma` — `name`, `duration` (detik), `isPreview`, `lessonStatus` |
| File audio | di dalam `Lesson.slidesData` (JSON) sebagai AudioTemplate berisi Bunny `guid` |
| Pemutaran | `buildStreamUrl(guid, courseId, isPreview)` → token AES-GCM → `/api/member/media/stream` (`optionalAuthGuard`) |
| Cek akses | `EntitlementService` + predikat di `packages/domain/src/commerce/enrollment.ts` (lihat §2b) |
| Config runtime | `AppSetting` + `SettingsService` (`get`/`getNumber`, cache ~60s) |
| Tracking dengar | `POST /api/tracking/session` → `listening_session` (append-only, sumber semua streak) |
| Rate limiter | `makeRateLimiter` di `packages/common/src/middlewares/rate-limit.middleware.ts` |
| Normalisasi teks | `packages/common/src/utils/plain-text.util.ts` |

`buildStreamUrl` masih private di `apps/mobile-api/src/modules/product/product.serializer.ts`
→ perlu diekspor/dipindah ke util bersama supaya dipakai product + playlist.

---

## 2. Skema

```prisma
model Playlist {
  id          String    @id @default(uuid(7)) @db.Uuid
  ownerId     String    @map("owner_id") @db.Uuid     // selalu ada — semua playlist milik member
  visibility  String    @default("PRIVATE")           // PRIVATE | UNLISTED (publik hanya via share)
  shareToken  String?   @unique @map("share_token")   // diisi saat share ON; NULL = OFF
  sharedAt    DateTime? @map("shared_at")
  copiedFromToken String? @map("copied_from_token")   // skalar biasa, TANPA FK
  name        String
  description String?
  coverUrl    String?   @map("cover_url")
  sortOrder   Int       @default(0) @map("sort_order")
  isActive    Boolean   @default(true) @map("is_active")
  isBlocked   Boolean   @default(false) @map("is_blocked") // kill-switch moderasi
  createdAt   DateTime  @default(now()) @map("created_at")
  updatedAt   DateTime  @updatedAt @map("updated_at")

  owner Member         @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  items PlaylistItem[]

  @@index([ownerId])
  @@index([isActive, sortOrder])
  @@map("playlists")
}

model PlaylistItem {
  id         String @id @default(uuid(7)) @db.Uuid
  playlistId String @map("playlist_id") @db.Uuid
  /// The slide inside `lesson.slides_data` that plays. Same name and id space as
  /// `listening_session.audio_id` — one name for one id.
  audioId    String @map("audio_id")
  /// Denormalised owner of that slide: a slide id lives inside JSON and cannot
  /// carry an FK, so this is what keeps ON DELETE CASCADE and the section → course
  /// join (entitlement, title, duration).
  lessonId   String @map("lesson_id") @db.Uuid
  order      Int    @default(0)

  playlist Playlist @relation(fields: [playlistId], references: [id], onDelete: Cascade)
  lesson   Lesson   @relation(fields: [lessonId],   references: [id], onDelete: Cascade)

  @@unique([playlistId, audioId])
  @@index([playlistId, order])
  @@map("playlist_items")
}

// kolom tambahan di model yang sudah ada
model Member { playlistQuota Int? @map("playlist_quota") }   // NULL = ikut setting global
model ListeningSession {
  playlistId String? @map("playlist_id") @db.Uuid            // NULL = dengar lepas; TANPA FK
  @@index([memberId, playlistId, startedAt])
}
```

Kenapa begitu:

- **`ownerId` NOT NULL** — tidak ada playlist tanpa pemilik. Kalau kelak produk mau playlist
  resmi bikinan BrainBoost, `ALTER COLUMN DROP NOT NULL` itu migrasi sepele tanpa rewrite
  data; jangan pasang nullable sekarang untuk kemungkinan yang belum ada.
- **`slug` dibuang.** Itu tadinya untuk playlist kurasi. Playlist member dirujuk lewat
  `shareToken` (§5) — slug buatan member malah membuka bentrok nama dan penyerobotan
  ("brainboost-official").
- **`courseId` tidak didenormalisasi** di item — ditelusuri `lesson → section → course`.
  Satu sumber kebenaran, tidak bisa basi.
- **`onDelete: Cascade` ke `Lesson`** — tim konten hapus lesson, item hilang, playlist hidup.
- **`listening_session.playlistId` tanpa FK** — konsisten dengan `audioId`; tulisan log tidak
  boleh gagal cuma karena playlist sudah dihapus.

---

## 2b. GERBANG UTAMA: playlist = fitur subscriber

**Playlist hanya bisa dipakai member dengan subscription aktif** (keputusan produk 2026-08-21).
Baca ini sebelum bagian lain — beberapa keputusan di bawah berubah bentuk karenanya.

### `locked` per item praktis tidak pernah true untuk pengguna sah

Subscription di repo ini **all-access**: `EntitlementService.assertCourseAccess` = enrollment
valid ATAU subscription aktif, dan kalau subnya aktif dia membuat enrollment lazy untuk course
**apa pun** — tidak ada whitelist produk. Jadi subscriber otomatis punya akses ke semua item
di playlist mana pun.

`locked` tetap dikirim, tapi maknanya berubah: bukan "upsell per audio", melainkan "kamu
belum/tidak berlangganan". Kasus yang menyisakannya:

- non-subscriber membuka link share — ini justru kasus utamanya sekarang;
- subscription habis atau member dievict dari seat → playlist lama jadi read-only terkunci;
- tier masa depan yang tidak all-access (Phase 2/3 = tambah row plan) — tanpa `locked` itu
  jadi perubahan kontrak API + rilis app.

### JANGAN panggil `assertCourseAccess` saat browse

`assertCourseAccess` **menulis** (membuat baris `course_enrollment` lazy). Memanggilnya per
item = satu kali buka playlist menulis sampai N baris enrollment untuk course yang belum tentu
pernah didengar: mengotori data enrollment dan menjadikan browse operasi tulis.

Aturan: **playlist detail hanya membaca** — `hasActiveSubscription(memberId)` sekali per
request, bukan per item. Lazy enrollment tetap terjadi di tempat yang benar, yaitu
`/media/stream` saat audio benar-benar diputar.

### Gerbang

```
assertPlaylistAccess(memberId) → hasActiveSubscription() ? ok : 403 SUBSCRIPTION_REQUIRED
```

Pakai `getActiveSubscriptionForMember` yang sudah ada (sudah menghitung grace:
`coalesce(grace_until, expires_at) > now`). **Jangan bikin definisi "aktif" kedua** — dua
definisi aktif di satu repo = bug pembayaran yang menunggu waktu.

| Endpoint | Gerbang |
|---|---|
| `GET /playlist/list?scope=mine` | bebas dibaca (playlist sendiri tetap terlihat saat langganan habis); tulis butuh subscriber |
| `GET /playlist/detail` | bebas dibaca; `streamUrl` hanya untuk subscriber |
| `GET /playlist/shared/:token` | bebas, **tetap tidak boleh 401** — target utamanya non-subscriber |
| play (dapat `streamUrl`) | subscriber |
| create / rename / add item / reorder / delete | subscriber |
| save / copy | subscriber |
| `scope=recent` / `scope=top` | subscriber (riwayat hanya lahir dari play) |

### Member free-trial TIDAK dapat playlist (keputusan 2026-08-24)

Free-trial voucher (`vouchers.type='TRIAL'`, mendarat 2026-08-20) memberi `course_enrollment`
time-boxed **tanpa subscription**. Di bawah gerbang di atas, member trial terblokir penuh dari
playlist — dan itu memang yang dimaui: **playlist adalah benefit langganan, bukan benefit
trial.** Ditulis eksplisit supaya tidak ditemukan sebagai kejutan saat coding; waktu desain
ini pertama disusun, trial belum ada.

### Kalau kill-switch dimatikan: pakai `activeEnrollment()`, BUKAN `OWNED_FOR_PURCHASE`

Dalam mode normal playlist tidak pernah bertanya per-course. Begitu
`playlist.requiresSubscription = false`, pertanyaannya berubah jadi per-item — dan di situ ada
dua predikat di `packages/domain/src/commerce/enrollment.ts` yang gampang tertukar:

| Kondisi member atas satu course | `activeEnrollment()` | `OWNED_FOR_PURCHASE` |
|---|---|---|
| Beli retail / legacy | ✓ | ✓ |
| Trial masih hidup | ✓ | ✗ |
| Trial sudah lewat | ✗ | ✗ |
| Baris lazy langganan, sub aktif | ✓ | ✗ |
| Baris lazy langganan, sub habis | ✗ | ✗ |
| Sudah refund (`is_canceled`) | ✗ | ✗ |

Yang benar untuk playlist: **`activeEnrollment()`** — "boleh konsumsi konten sekarang".
`OWNED_FOR_PURCHASE` sengaja menolak trial dan langganan supaya guard checkout tidak
memblokir member membeli course yang sedang di-trial-kan; dia **hanya** untuk guard checkout.

Kalau salah pilih: member trial dan **semua subscriber** dapat `locked: true` di setiap item —
padahal `/media/stream` (pakai `assertCourseAccess`) tetap mengizinkan. Badge bilang terkunci,
audionya jalan. Dua sumber kebenaran yang tidak sepakat, laporannya terdengar acak, dan tidak
ada yang menghubungkannya ke pilihan predikat.

Dua jebakan turunan:

- **Jangan bikin predikat ketiga.** Sudah ada dua bentuk yang wajib cermin: `activeEnrollment()`
  (SQL) dan `EntitlementService.isEnrollmentValid` (in-memory). Menulis `where` sendiri di
  playlist akan menyimpang diam-diam saat penanda hibah ketiga muncul.
- **`activeEnrollment` itu fungsi, bukan konstanta.** `new Date()` di objek level-modul membeku
  di detik proses boot; semua hibah lalu kelihatan valid (atau kedaluwarsa) selamanya. Sudah
  ditulis sebagai peringatan di file itu — jangan disalin jadi `const`.

### Kehilangan akses → read-only, JANGAN dihapus

Dua pemicu, efeknya sama:

1. **Subscription habis** (lewat grace).
2. **Dievict dari seat** — saat downgrade terjadwal diterapkan, seat yang tidak ditandai
   `pending_keep` kehilangan tempat (tier change 2026-08-21). Ini pemicu di tengah term, bukan
   di akhir.

Playlist member tetap ada, isinya terkunci, tombol perpanjang di atasnya. Bayar lagi / diundang
balik → hidup kembali tanpa migrasi, karena `locked` diturunkan saat baca, bukan disimpan
(prinsip sama dengan copy §6). Menghapus playlist saat akses hilang = menghapus alasan orang
berlangganan lagi. Kuota tidak diapa-apakan; yang lewat batas cuma tidak bisa bikin baru.

Ikuti pola yang sudah dipakai subscription pada eviction: member yang diundang balik
enrollment-nya **di-refresh, bukan dibuat ulang**, sehingga `progress` kekal. Playlist harus
setara — dievict lalu diundang lagi, playlistnya utuh, riwayatnya utuh.

### Kill-switch

Setting `playlist.requiresSubscription` (default `true`) — membuka playlist untuk semua orang
saat kampanye jadi satu baris SQL, bukan deploy. Pola `disbursement.autoEnabled`.

### Efek ke beban kerja

V1 justru **menyusut**: `PlaylistService` tidak perlu resolve entitlement per item — cukup satu
cek langganan per request, lalu mint token untuk semua item. Hilang satu query per item dan
satu lapis logika.

---

## 2c. Item playlist dikunci ke `audioId`, bukan `lessonId` (2026-08-25)

Diukur di `listening_session` (148.644 baris, DB dev):

| `audioId` menunjuk | Distinct | Sesi |
|---|---|---|
| Slide `AudioTemplate` | 49 | 135.309 (91%) |
| Slide `VideoTemplate` | 76 | 13.279 (9%) |
| Tidak cocok apa pun | 7 | 56 |
| **`Lesson.id`** | **0** | **0** |

Komentar lama di schema menyebut `audioId` = `Lesson.id`. **Salah**, dan sempat menyesatkan
desain V1: playlist dikunci ke `lessonId` sebagian karena komentar itu. Sudah diperbaiki di
`prisma/schema.prisma` beserta angkanya.

Konsekuensi:

- **Item playlist memakai `audioId`** — nama dan ruang id yang sama dengan log dengar, jadi
  item dan sesi yang dihasilkannya bisa di-join. Nama `audioId` memang tidak akurat (9%
  `VideoTemplate` — "audio" di Bunny itu video gambar diam), tapi nama kedua untuk nilai yang
  sama lebih menyesatkan daripada satu nama yang kurang tepat.
- **`lessonId` tetap ada, didenormalisasi.** Slide id hidup di dalam JSON dan tidak bisa
  memikul FK; kolom lesson yang memberi `ON DELETE CASCADE` dan menjadikan lookup
  section → course (entitlement, judul, durasi) sebuah join, bukan pemindaian.
- **`VideoTemplate` ikut diterima.** V1 hanya mencari `AudioTemplate` dan karena itu diam-diam
  membuang 9% konten yang benar-benar didengar member.
- **Referensi menggantung itu nyata**, bukan teori: 7 id di log sudah tidak cocok slide mana
  pun (salah satunya `M9QIMS4V4LK09` vs `M9QIMS4V4LK09K` — beda satu karakter). Pembacaan
  membuang item yang slidenya hilang, bukan merendernya sebagai baris mati.
- **FE tidak perlu endpoint baru.** `scrubSlide` di product serializer sudah memancarkan
  `slides[].id` sejak dulu; itulah nilainya.

Menambah item lewat `audioId` juga memungkinkan satu lesson menyumbang lebih dari satu audio —
hari ini belum ada (111 lesson, semuanya tepat satu slide audio), tapi tidak lagi tertutup.

Migrasi: `20260825120000_playlist_item_audio_id` (terpisah; `20260824120000_playlist` tidak
disentuh).

---

## 3. Penyisip (interlude)

Setting `playlist.interludeAssetId` (`SETTING_KEYS.playlistInterludeAssetId`), fallback kosong
= penyisip mati.

**Simpan Bunny `guid`, BUKAN URL.** URL mentah membocorkan host CDN + guid ke app — persis yang
modul `media` dibangun untuk menyembunyikan — dan lewat jalur itu tidak ada rate limit maupun
cara mencabut. Server mint token `isPreview: true` per request → keluar sebagai
`interludeStreamUrl` biasa, bisa diputar tanpa enrollment, modul media tidak disentuh.

Jalur "upload MP3 ke S3 publik" **jangan diambil**: modul upload menolak semua non-gambar
(blocker yang sama dengan §9 PDF).

### Guard kontaminasi tracking — WAJIB, bukan opsional

`TrackingService.record` menerima `audioId` string bebas: **tanpa FK, tanpa validasi ke
`Lesson`** (disengaja — log ingest tidak boleh gagal karena lesson dihapus). Artinya jaminan
"penyisip tidak masuk `ListeningSession`" saat ini 100% bergantung disiplin client. Satu bug
player = ambang streak 10 menit jadi bohong untuk semua member, diam-diam, dan sulit dideteksi
berbulan-bulan kemudian.

Perbaikan: ingest **membuang** sesi penyisip. Yang dibandingkan ada DUA nilai, dan urutannya
penting:

1. **`INTERLUDE_AUDIO_ID` (`"__interlude__"`)** — sentinel yang ikut dikirim di response detail
   sebagai `interludeAudioId`. Ini yang benar-benar menutup lubangnya.
2. `playlist.interludeAssetId` (guid Bunny) — pintu kedua, untuk pemanggil yang entah bagaimana
   tahu guid-nya.

Kenapa sentinel-nya wajib: **guid tidak pernah sampai ke client** — app cuma memegang token
stream opaque. Jadi guard yang hanya membandingkan guid tidak akan pernah menyala, sementara
mis-report yang realistis (player mengarang `audioId` sendiri, karena dia memang tidak punya id
untuk penyisip) lewat begitu saja. Versi pertama guard ini ditulis guid-only dan karena itu
menjaga kasus yang praktis mustahil sambil membiarkan yang mungkin — lebih berbahaya daripada
tidak ada guard, karena dokumennya menyatakan masalah sudah pindah ke server.

Kontraknya: server mengumumkan `interludeAudioId`, dokumen mobile menyuruh app memakai nilai itu
kalau memang melacak penyisip, dan ingest membuangnya. Guard ini sekaligus menjaga riwayat
playlist (§7) tetap bersih.

---

## 4. Kuota playlist per member

Dua lapis:

1. Global: `app_settings` key `playlist.maxPerMember`, fallback konstanta
   `PLAYLIST_MAX_PER_MEMBER_DEFAULT = 20`, di-seed (insert-only).
2. Per member: `members.playlist_quota Int?`. **NULL = ikut global** (keadaan normal; kalau
   tiap baris diisi angka, mengubah default global jadi percuma).

```
limit = member.playlistQuota ?? setting('playlist.maxPerMember') ?? 20
```

Override per member selalu menang, termasuk kalau lebih kecil — jadi kolom ini sekaligus jalur
hukuman untuk pelaku abuse, bukan cuma jalur VIP.

Sentinel (berlaku di kedua lapis):

- `-1` = tanpa batas.
- `0` = tidak boleh membuat sama sekali. Global `0` = kill-switch UGC tanpa deploy.
- **`0` BUKAN unlimited** — sering tertukar; tulis di komentar kolom + deskripsi setting.

Penegakan **hanya di `PlaylistService.create`** (termasuk jalur copy/fork). Jangan disebar ke
rename/reorder/delete: member yang melewati batas karena limitnya diturunkan tetap harus bisa
merapikan miliknya.

```
hitung = playlist.count({ where: { ownerId: memberId } })
limit >= 0 && hitung >= limit → 400 PLAYLIST_QUOTA_EXCEEDED  details { limit, current }
```

Race dua create paralel bisa lolos 1 baris. Kalau mau ketat: interactive tx + kunci baris member
(`SELECT id FROM members WHERE id = ? FOR UPDATE`) sebelum count+insert — preseden lock-dalam-tx
ada di rotasi refresh token.

**Limit diturunkan di bawah jumlah yang sudah ada: tidak ada yang dihapus.** Member cuma berhenti
bisa bikin baru. Ditulis eksplisit supaya tidak ada yang kelak membuat job pembersih.

Ke FE: `meta.quota = { limit, used, remaining }`. Unlimited dikirim `limit: null`, **jangan**
kirim `-1` (nanti ada FE yang menampilkan "maks -1").

---

## 5. Share

Link: `https://link.brainboost.id/p/{shareToken}` — app terinstall → deep link ke layar playlist;
belum install → halaman fallback + tombol store.

**Yang dibagikan bukan `id`.** UUID v7 membawa timestamp pembuatan dan tidak bisa dicabut.
`shareToken` = acak kripto ≥64 bit (base62 ~11 char), lahir saat share dinyalakan, `NULL` saat
dimatikan, bisa dirotasi. Itu yang membuat share bisa ditarik kembali.

Endpoint:

```
POST   /playlist/:id/share             mint (idempoten) → { shareToken, shareUrl }
POST   /playlist/:id/share?rotate=true token baru, link lama mati
DELETE /playlist/:id/share             cabut
GET    /playlist/shared/:token         PUBLIK — optionalAuthGuard
POST   /playlist/shared/:token/save    salin jadi milik penerima (authGuard + subscriber)
```

`GET /playlist/shared/:token` **wajib tidak pernah menjawab 401.** Interceptor mobile menempelkan
bearer apa pun yang dia pegang termasuk yang kedaluwarsa, dan 401 di layar share memicu
refresh/logout paksa. Aturan sama dengan `/app/version-check`; preseden anonim ada di
`/affiliate/visits`.

Yang dilihat penerima:

| Penerima | Metadata | Daftar item | Audio |
|---|---|---|---|
| Subscriber | ✓ | ✓ | ✓ `streamUrl` |
| Non-subscriber (punya akun) | ✓ | ✓ | ✗ `locked: true`, `streamUrl: null` |
| Anonim | ✓ | ✓ | hanya lesson `isPreview` |

**Link bocor ≠ audio bocor.** Judul + durasi boleh publik (halaman produk juga publik);
`streamUrl` cuma di-mint untuk yang berhak, dan penjagaan sebenarnya tetap di `/media/stream`.
Aturan keras: **endpoint share tidak boleh punya jalur apa pun yang mint token untuk yang tidak
berhak**, sekalipun demi "preview" — kalau memang mau preview, pakai lesson yang `isPreview`.

Anti-abuse: rate limit di endpoint baca share (cegah token diayak) dan di mint/rotate. Token dari
`crypto.randomBytes`, bukan turunan `id`.

Moderasi: pemilik cabut → token NULL. Ops → `isBlocked = true` → endpoint balas **404**, bukan 403
(jangan konfirmasi keberadaannya). Playlist/owner dihapus → cascade. Catatan: playlist UGC publik
= permukaan report ketiga yang belum ada (sekarang report hanya untuk **post** dan **member**).

---

## 6. Play tanpa simpan, dan copy

Playlist yang dibagikan **bisa langsung diputar tanpa disimpan** — `GET /playlist/shared/:token`
sudah mengembalikan `streamUrl` (untuk yang berhak); player tinggal jalan. Tidak ada state server,
tidak ada baris yang dibuat. App menyimpan token-nya secara lokal untuk "lanjutkan yang tadi".

Link dicabut di tengah pemutaran: pemutaran **tidak putus** (item sudah dimuat, token media hidup
~2 jam); fetch berikutnya 404. Perilaku benar — tulis eksplisit supaya tidak dilaporkan sebagai bug.

`POST /playlist/shared/:token/save` idempoten per (`ownerId`, `copiedFromToken`) — tekan dua kali
mengembalikan salinan yang sama. Response baca membawa `isSaved` supaya tombol berubah jadi
"Buka salinanku".

Non-subscriber **tidak bisa menyimpan** (semua tulisan butuh langganan). Konsekuensi FE: bagi
mereka link itu satu-satunya artefak — tidak ada salinan, tidak ada riwayat (riwayat lahir dari
play, play butuh langganan). Tombolnya jadi **"Berlangganan untuk menyimpan"**, dan setelah
checkout harus mendarat balik di playlist yang sama; kalau tidak, corong share putus persis di
titik konversinya. App menahan token share melewati checkout.

### Copy playlist yang isinya tidak dimiliki penyalin: SALIN APA ADANYA

`playlist_items` hanya menyimpan `audioId` + `lessonId`. Status `locked` **dihitung ulang tiap baca, per
member**. Baris yang sama: terkunci hari ini → terbuka setelah berlangganan → terkunci lagi saat
langganan habis. Nol migrasi, nol job, nol state basi.

Dua alternatif yang ditolak:

- *Salin hanya yang dimiliki* → playlist 8 jadi 2 tanpa penjelasan, dan 6 item itu **tidak kembali**
  saat member akhirnya berlangganan.
- *Tolak copy kalau ada yang terkunci* → membunuh nilai utama share.

Aturan turunan:

1. **Jangan pernah simpan kolom `locked`/`isOwned` di DB.** Turunan, bukan fakta.
2. Response bawa `{ totalItems, lockedItems }`.
3. Semua item terkunci → app tampilkan upsell, **jangan** buka player (penyisip jangan diputar
   sendirian; itu juga mengotori metrik).
4. Item terkunci tidak bisa diputar → tidak pernah menghasilkan `listening_session`.
5. Copy/fork **butuh subscription aktif** (§2b) **dan kena kuota** (§4).
6. `copiedFromToken` disimpan untuk analitik + atribusi komisi kelak — skalar, tanpa FK, supaya
   playlist sumber boleh dihapus tanpa merusak salinan. Jangan pakai FK `sourcePlaylistId`.

---

## 6b. Membuat playlist (UGC)

### Pintu masuk di app

1. **Dari player / halaman lesson** — "Tambah ke playlist" → bottom sheet daftar playlist member +
   "Buat playlist baru" → nama → audio yang sedang diputar jadi item pertama. **Ini alasan
   `POST /playlist` menerima `audioIds` sekaligus:** kalau create dan add-item dipisah paksa,
   tiap alur ini jadi dua panggilan, dan gagal di panggilan kedua meninggalkan playlist kosong
   nyangkut.
2. **Dari tab Playlist** — tombol "+", playlist kosong, isi belakangan.
3. **Dari playlist orang lain** — `POST /playlist/shared/:token/save` (§6), kuota sama.

### Endpoint

```
POST   /playlist                 { name, description?, coverUrl?, audioIds?[] } → 201
PATCH  /playlist/:id             { name?, description?, coverUrl? }
DELETE /playlist/:id
POST   /playlist/:id/items       { audioIds: [...] }   append di akhir
DELETE /playlist/:id/items       { audioIds: [...] }
PUT    /playlist/:id/items/order { audioIds: [...] }   urutan final, tulis ulang dalam satu tx
```

Semua `authGuard` + `assertPlaylistAccess` (§2b) + cek `ownerId === req.user.id` — pemilik saja,
tanpa pengecualian.

**Reorder pakai array urutan final, bukan patch per-item.** Patch per-item bisa menghasilkan
urutan setengah jadi kalau satu panggilan gagal di tengah, dan server tidak punya cara
memperbaikinya.

### Aturan

- **Nama**: wajib, 1–80 char, dinormalisasi `plain-text.util` — bukan demi tampilan app, tapi
  karena nama ini muncul di halaman share/notifikasi. Yang tidak dinormalisasi di titik tulis akan
  bocor di titik-titik itu.
- **Kuota** dicek **hanya** saat create (termasuk copy) — §4.
- **Batas item per playlist**: setting `playlist.maxItems`, fallback 200. Kuota playlist saja tidak
  menutup satu playlist berisi puluhan ribu baris.
- **Item duplikat bukan error.** `@@unique([playlistId, audioId])` → balas 200 dengan
  `{ added, alreadyPresent }`. Alur bottom-sheet sering mengenainya; 409 di situ terasa bug.
- **Validasi lesson**: harus ada dan `lessonStatus = ACTIVE`. Yang tidak lolos dibuang dan
  dilaporkan (`skipped: [...]`), jangan gagalkan seluruh request karena satu id basi dari cache
  client.
- **Boleh menambahkan audio apa pun** — dengan gerbang subscriber (§2b) semuanya memang terbuka;
  aturan ini tetap ditulis supaya perilakunya jelas kalau kelak ada tier non-all-access.
- **Visibility default `PRIVATE`.** Playlist jadi terlihat orang lain hanya lewat share yang
  dinyalakan sendiri oleh pemiliknya (`UNLISTED`).
- **Playlist kosong boleh ada**, tapi share tidak bisa dinyalakan sebelum ada isi; penyisip baru
  bermakna saat item ≥ 2 (AC PRD).
- **Cover**: `coverUrl` kosong → jangan simpan apa pun, turunkan saat baca dari cover course item
  pertama. Menyimpannya = cover basi begitu item pertama diganti.
- **Rate limit** di `POST /playlist` (`makeRateLimiter`).

### Response create

```jsonc
{ "id": "...", "name": "Pagi Fokus", "visibility": "PRIVATE",
  "totalItems": 1, "lockedItems": 0,
  "quota": { "limit": 20, "used": 8, "remaining": 12 } }
```

`quota` ikut supaya app bisa menonaktifkan tombol "buat playlist" tanpa panggilan kedua.

---

## 7. Riwayat: recent + top

**Diturunkan dari `listening_session`, bukan dari event "playlist dibuka".** Laporan "dibuka"
murah dibaca tapi angkanya sampah (salah tap ikut terhitung, dan "top" jadi peringkat orang yang
salah pencet). Ongkos jalur turunan: satu kolom `listening_session.playlist_id` + index
`[memberId, playlistId, startedAt]`.

Bonus di luar riwayat: baru setelah kolom ini ada, "audio ini didengar dari playlist mana" bisa
dijawab sama sekali.

Definisi yang dikunci:

- **Terhitung diputar** = ada `listening_session` dengan `playlistId` itu dan `listenedSec >= 1`.
  Diturunkan dari 30 ke 1 detik (2026-08-31): playlist dari link share biasanya dicicipi beberapa
  detik dulu, dan di ambang 30 sampel itu tak berbekas — playlist tak pernah masuk recent, jadi
  tak ada jalan kembali selain link aslinya. Penemuan dimenangkan atas kebersihan salah tap.
  Ongkosnya di `recent`, yang urut `max(startedAt)`: salah tap kini merebut slot teratas. `top`
  tidak berubah peringkatnya (menjumlah detik), cuma ekornya jadi berisik. (Beda tujuan dengan
  ambang streak 600 detik — jangan disamakan.)
- **Recent** = urut `max(startedAt)` per playlist, turun. **Daftar saja, tanpa posisi terakhir** —
  resume dititipkan ke lokal app. Resume lintas device ditunda dan sebaiknya digabung polanya
  dengan progres video BB-127, bukan dua bentuk berbeda untuk masalah yang sama.
- **Top** = urut **total detik didengar**, bukan jumlah buka. Lebih jujur, tidak bisa
  digelembungkan. Rentang default **30 hari** (tanpa rentang, top membeku selamanya di playlist
  yang didengar 8 bulan lalu).
- Penyisip tidak pernah masuk — ditutup guard §3.
- Anonim tidak punya riwayat.

Baca **diturunkan saat request**, tanpa tabel pra-agregasi (kardinalitas puluhan playlist per
member). Filosofi sama dengan tracker home. Pra-agregasi hanya kalau ada angka yang membuktikan
perlu.

Endpoint aditif lewat `scope`:

```
GET /playlist/list?scope=mine           (default — V1)
                  ?scope=recent         (V3)
                  ?scope=top&range=30d  (V3)
```

### Penyaringan hantu (wajib)

Playlist di riwayat bisa sudah dihapus, share-nya dicabut, atau diblokir. Tanpa saringan, member
melihat kartu yang kalau ditekan langsung 404.

**Keputusan: hilangkan diam-diam dari riwayat** — tanpa nisan, tanpa pesan. Menampilkan
"Playlist X — tidak tersedia" membocorkan bahwa playlist itu pernah ada, namanya apa, dan baru saja
dicabut; itu membatalkan maksud pencabutan. (Kebiasaan industri: item *di dalam* playlist yang
hilang tetap ditampilkan sebagai baris mati — YouTube "Private video" — tapi playlist yang hilang
*seluruhnya* memang lenyap dari recently-played.)

Aturan baca recent/top: hanya playlist yang masih bisa diakses member itu — miliknya sendiri ATAU
`shareToken` masih terisi — dan baris yang playlist-nya sudah tidak ada langsung dibuang, **bukan**
dirender "Untitled".

Pengecualian: **playlist yang sudah disalin tidak terpengaruh apa pun** — salinan itu milik member.
Karena itu tombol "Simpan" harus jelas di UI: riwayat itu kenyamanan, salinan itu jaminan.

Peringkat lintas member ("playlist terpopuler di BrainBoost") **fitur lain** — butuh job agregasi +
keputusan privasi + bahan moderasi. Tiket sendiri.

---

## 8. Bentuk response detail

```jsonc
{
  "id": "...", "name": "Pagi Fokus", "coverUrl": "...",
  "requiresSubscription": true,
  "interludeStreamUrl": "https://.../media/stream?token=...",  // null kalau setting kosong
  "interludeAudioId": "__interlude__",                         // null kalau penyisip mati
  "totalItems": 8, "lockedItems": 0,
  "isOwner": false, "isSaved": false,
  "items": [
    { "audioId": "M2WYRVCUV6JB5", "lessonId": "...", "courseId": "...",
      "name": "BrainBoost Money Magnet", "durationSec": 612,
      "coverUrl": "https://…/course-thumb.jpg", "courseCode": "zb22segg",
      "order": 1, "locked": false, "streamUrl": "https://.../media/stream?token=..." },
    { "audioId": "M49ZYH47XRRU3", "lessonId": "...", "courseId": "...",
      "name": "BrainBoost Money Magnet", "durationSec": 480,
      "order": 2, "locked": true,  "streamUrl": null }
  ]
}
```

Item terkunci dikirim, tidak disembunyikan: menyembunyikan bikin jumlah item beda-beda per member,
share link jadi tidak konsisten, dan playlist bisa menyusut jadi 1 audio. `locked` cuma petunjuk
UI — penjagaan tetap di `/media/stream`.

**`coverUrl` + `courseCode` per item** (permintaan mobile, 2026-08-25). Keduanya ikut di join
yang sudah jalan untuk `title`, jadi nol query tambahan. Alasannya tidak bisa diselesaikan di
app: item `locked` datang dari course yang tidak pernah masuk daftar member, jadi cache lokal
mereka kosong untuk itu; sampul yang muncul-kadang-tidak lebih buruk daripada satu field.
Dikirim juga untuk item terkunci dan ke penonton anonim di halaman share — sampul katalog
memang publik, dan itu yang membuat halaman share menjual. `courseCode` = `products.code`
(`zb22segg`); kalau route app ternyata memakai bentuk terbaca (`brainboost-bela-diri-1`) itu
`products.slug`, kolom lain.

**`coverUrls` — s.d. 4 sampul course distinct** per playlist (permintaan mobile 2026-08-25),
urut kemunculan pertama, untuk ubin mosaik di layar pustaka. Dedup itu inti permintaannya:
playlist yang seluruh itemnya satu course harus menghasilkan SATU url, bukan empat salinan —
empat ubin identik terbaca sebagai bug render, bukan kolase. Di list diturunkan lewat satu
query window function (`GROUP BY` untuk dedup, `MIN(order)` untuk urutan, `ROW_NUMBER() <= 4`
untuk potong); di detail diturunkan dari `items[]` yang sudah dimuat, nol query. Dikirim di
kedua endpoint supaya app membaca satu bentuk, bukan menyusun sendiri di satu layar dan membaca
di layar lain. `coverUrl` tidak berubah — tetap ubin tunggal untuk mini player dan lock screen,
dan sekarang isinya `coverUrls[0]`.

Diketahui dan diterima: query list menghitung item yang slide-nya sudah lenyap, yang justru
dibuang `detail()`. Menangkapnya berarti memindai `slides_data` di dalam SQL per item — jauh
lebih mahal daripada satu ubin basi.

**`playlist.coverUrl` diturunkan** dari cover course item pertama saat kosong — di detail DAN
di list. Member tidak punya UI untuk mengisi cover, jadi tanpa ini seluruh tab Playlist abu-abu.
Tetap tidak pernah disimpan (§6b): begitu item pertama berganti, nilai tersimpan jadi basi.
Di list dipakai satu query `DISTINCT ON` — versi naifnya membaca ribuan baris item untuk
memakai dua puluh.

**`name` item = `product.title`**, bukan judul lesson maupun judul slide (keputusan produk
2026-08-25). Konsekuensi yang sudah diketahui: beberapa item dari course yang sama tampil
dengan nama identik — diukur, 60 dari 60 produk punya lebih dari satu lesson, dan satu produk
punya 27. Judul yang membedakan ada di `slide.data.title` (196 dari 197 slide punya, 128 di
antaranya berbeda dari nama lesson) kalau kelak dibutuhkan.

**Token stream TTL 2 jam** (`MEDIA_SIGNED_URL_TTL_SECONDS`) → response detail tidak boleh di-cache
FE lebih lama dari itu.

---

## 9. Pentahapan

| Tahap | Isi | Beban |
|---|---|---|
| **V1 — BB-125** | Migrasi `playlists` + `playlist_items` + kolom share (nullable) + `members.playlist_quota` + `listening_session.playlist_id`; setting penyisip + `playlist.maxPerMember` + `playlist.maxItems` + `playlist.requiresSubscription` + seed; export `buildStreamUrl`; gerbang subscriber; **CRUD UGC penuh** (§6b) + kuota + rate limit + normalisasi nama; detail + play + penyisip; **guard ingest penyisip**; spec | ~3–4 hari BE |
| **V2 — share + copy** | mint/rotate/cabut, `GET /playlist/shared/:token` publik, save idempoten, kebijakan nama pembuat, `isBlocked` + report playlist | ~2 hari BE + kerjaan mobile (universal link + halaman fallback) yang tidak kecil |
| **V3 — riwayat** | `scope=recent`, `scope=top&range=`, penyaringan hantu, spec | ~0,5–1 hari BE |

**Kolom `listening_session.playlist_id` dan kolom share dikirim di V1** walau fiturnya di V2/V3 —
itu selisih antara meluncurkan riwayat dengan data berbulan-bulan versus meluncurkannya kosong, dan
antara V2/V3 aditif versus V2/V3 bermigrasi.

Catatan effort: PRD menaksir §7 sebagai **L** untuk playlist kurasi saja. UGC menaikkan V1 dari
~2 hari jadi ~3–4 hari (CRUD, kuota, validasi, moderasi dasar), tapi menghapus seluruh pekerjaan
kurasi — termasuk UI/pengisian konten yang belum punya rumah sama sekali. Total V1–V3 setara L.

---

## 10. Test yang wajib

- Penyisip **tidak pernah** masuk `listening_session` — diuji lewat sentinel `__interlude__`
  (jalur yang benar-benar bisa ditempuh app) DAN lewat guid, bukan cuma salah satu.
- Non-subscriber: `streamUrl: null` di semua item **dan** `/media/stream` tetap 403 kalau token
  lama dipaksa; endpoint tulis 403 `SUBSCRIPTION_REQUIRED`.
- **Member free-trial** (punya `course_enrollment` time-boxed, tanpa subscription) ditolak di
  semua endpoint playlist — trial bukan tiket masuk.
- **Member yang dievict dari seat**: playlist miliknya tetap ada, terbaca, read-only; diundang
  balik → bisa ditulis lagi tanpa perubahan data.
- Subscription habis → playlist tetap ada dan terbaca, tulis ditolak; perpanjang → hidup lagi.
- Playlist detail **tidak menulis** baris `course_enrollment` (regresi lazy-enrollment saat browse).
- Kuota: batas persis (`used == limit` ditolak, `used == limit-1` lolos); override per member menang
  dua arah; `-1` unlimited; `0` memblokir; limit diturunkan → create ditolak tapi delete/rename
  jalan.
- Copy: playlist dengan 6 item terkunci tersalin utuh 8 item; setelah subscription aktif, item yang
  sama jadi `locked: false` tanpa perubahan data.
- Share: token dicabut → 404; `isBlocked` → 404 (bukan 403); endpoint share tidak pernah 401.
- Riwayat: playlist yang share-nya dicabut hilang dari recent; salinan milik sendiri tetap ada.
- Tidak ada jalur yang bisa membuat playlist tanpa `ownerId` (NOT NULL dijaga di DB, bukan hanya
  di service).

---

## 11. Masih terbuka

1. Share ke sesama member di dalam app saja, atau link publik ke orang luar? (menentukan apakah
   halaman web fallback perlu ada sama sekali — sekarang tidak ada halaman web publik)
2. Nama pembuat di layar share: sensor (`Warda J.`), penuh, atau opt-in? Preseden repo (leaderboard
   affiliate) menyensor nama orang lain.
3. Deferred deep link — token bertahan melewati install?
4. Item duplikat dalam satu playlist boleh? (sekarang dilarang unique `[playlistId, audioId]`)
5. **Empty state**: tab Playlist kosong untuk semua member baru karena tidak ada konten bawaan.
   Cukup diselesaikan dengan copywriting + tombol "buat dari audio terakhir", atau produk mau
   beberapa playlist resmi sebagai contoh? (kalau ya, `ownerId` perlu dibuat nullable — migrasi
   sepele, tapi keputusannya sebaiknya sekarang)

---

## 12. Keputusan yang sudah terkunci

| Pertanyaan | Keputusan | Tanggal |
|---|---|---|
| Playlist kurasi vs UGC | **UGC saja** — tidak ada playlist kurasi; `ownerId` NOT NULL, `slug` dibuang | 2026-08-21 |
| Penyisip disimpan sebagai apa | Bunny `guid` di `app_settings`, bukan URL | 2026-08-21 |
| Penyisip masuk `ListeningSession`? | Tidak — guard di sisi server, bukan disiplin client | 2026-08-21 |
| Bagaimana guard penyisip mengenali sesinya | Sentinel `__interlude__` yang diumumkan ke client, guid sebagai pintu kedua | 2026-08-25 |
| Item playlist menunjuk apa | `audioId` (id slide, sama dengan tracker) + `lessonId` didenormalisasi untuk FK | 2026-08-25 |
| Nama item di response | `product.title` — bukan lesson/slide title; item se-course tampil kembar | 2026-08-25 |
| Sampul + kode course di item | `coverUrl` (`products.thumbnail`) + `courseCode` (`products.code`), nol query tambahan | 2026-08-25 |
| Cover playlist kosong | Diturunkan dari item pertama saat baca, tidak pernah disimpan | 2026-08-25 |
| Mosaik pustaka | `coverUrls` s.d. 4 distinct, urut kemunculan; satu course = satu url | 2026-08-25 |
| Kuota playlist | Dua lapis: `app_settings` + `members.playlist_quota` (NULL = ikut global) | 2026-08-21 |
| Copy playlist berisi item terkunci | Salin apa adanya; `locked` dihitung saat baca | 2026-08-21 |
| Riwayat playlist | Diturunkan dari `listening_session` + kolom `playlist_id` | 2026-08-21 |
| `top` playlist | Total detik didengar, rentang default 30 hari | 2026-08-21 |
| `recent` playlist | Daftar saja, tanpa posisi terakhir; resume lokal app | 2026-08-21 |
| Playlist dicabut/dihapus di riwayat | Hilang diam-diam, tanpa nisan | 2026-08-21 |
| Gerbang fitur | Subscription aktif (grace ikut) | 2026-08-21 |
| Non-subscriber boleh save playlist share? | **Tidak** — semua tulisan butuh langganan | 2026-08-21 |
| Member free-trial dapat playlist? | **Tidak** — playlist benefit langganan, bukan benefit trial | 2026-08-24 |
| Predikat saat kill-switch dimatikan | `activeEnrollment()`, bukan `OWNED_FOR_PURCHASE` | 2026-08-24 |
| Kehilangan akses karena eviction seat | Sama dengan expiry: read-only, playlist tidak dihapus | 2026-08-24 |
