# PRD — Voucher Pembeli Pertama (First-Purchase Voucher)

> Setiap member yang **baru pertama kali membeli** kursus menerima email berisi **satu kode voucher pribadi** untuk pembelian berikutnya. Berlaku untuk pembelian lewat sistem baru (app + shop.brainboost.id) **dan** pembelian yang masih masuk lewat Tribelio (datang lewat resync). Voucher hanya bisa dipakai oleh member penerimanya, hanya di shop.brainboost.id / app baru, dan dikelola lewat **menu backoffice terpisah** dari halaman Voucher.
> Status: DRAFT — hasil brainstorm produk 15 Sep 2026, belum ada task Jira. Backlog: project **BB**, prefix `[BE]` / `[BO]` / `[COMMS]`, label `first-purchase-voucher`.
> Dokumen terkait: `docs/commerce-port.md` §8b (voucher, TRIAL, redeem idempoten), `docs/legacy-resync-plan.md` §enrollments, `docs/notification-port.md` (outbox comms), CLAUDE.md §5 (aturan voucher redeem + legacy trial).

---

## 0. Ringkasan satu paragraf

Sebuah **job per jam** di `bb-cron` mencari member yang pembelian kursus **pertamanya** terjadi sejak fitur diaktifkan, membuat **satu baris `vouchers`** per member (`quota = 1`, terkunci ke `owner_member_id`, ditandai `campaign = 'FIRST_PURCHASE'`), lalu mengirim email lewat bb-comms. Sumber pembelian ada dua: order `PAID` di `commerce_transactions` (jalur baru) dan baris `course_enrollment` yang dibawa resync dari Tribelio (jalur legacy). Keduanya diproses oleh **satu job, satu aturan** — tidak ada hook di listener pembayaran, tidak ada hook di resync-worker. Checkout tidak berubah kecuali satu cek pemilik di `VoucherService.validate()`. Backoffice mendapat menu baru **Voucher Pembeli Pertama** (pengaturan program, ringkasan, daftar per member + kirim ulang), dan halaman Voucher yang ada menyembunyikan baris ber-`campaign`. Tidak ada rilis mobile.

---

## 1. Keputusan produk (hasil brainstorm 15 Sep)

| # | Keputusan | Konsekuensi desain |
|---|---|---|
| P1 | Buyer dari Tribelio **ikut dapat email**, voucher **hanya bisa dipakai di shop.brainboost.id / app baru** | Bukan pilihan, tapi konsekuensi: resync satu arah (Postgres tidak pernah menulis ke MariaDB), voucher legacy tidak dimigrasi. Email jadi alat migrasi: "login pakai akun yang sama" (password legacy sudah jalan di sistem baru) |
| P2 | Voucher **nempel ke satu member** | Kolom `vouchers.owner_member_id`; `validate()` menolak member lain dengan jawaban **generik** `VOUCHER_INVALID` (bukan "milik orang lain"), supaya kode tidak bisa di-probe |
| P3 | Voucher pembeli pertama **tidak tampil di halaman Voucher** backoffice; ada **menu terpisah** untuk pengaturan + laporan | Tetap **satu tabel** `vouchers` (jalur redeem + `voucher_redemptions` tidak disentuh), dibedakan kolom `campaign`. Halaman Voucher memfilter `campaign IS NULL` |
| P4 | Satu member **maksimal satu** voucher pembeli pertama, seumur hidup | Partial unique `(owner_member_id, campaign)`. Member yang kena dua jalur (beli di Tribelio dan di app) tetap dapat satu |
| P5 | Hanya pembelian **sejak tanggal aktivasi** yang dihitung | Setting `firstPurchaseVoucher.launchAt`. Member yang sudah punya pembelian sebelum tanggal itu **tidak pernah** dapat — tidak ada backfill ke pembeli lama |
| P6 | Yang memicu voucher = **pembelian kursus berbayar** saja; trial, kursus gratis, dan tiket event **tidak** dihitung (dikonfirmasi 15 Sep) | Jalur baru: order `PAID` dengan `total > 0` pada produk kursus. Jalur legacy: `course_enrollment` tanpa `expired_date` (bukan trial) pada kursus dengan `products.price > 0` |
| P7 | Voucher **hanya bisa dipakai untuk kursus**; tiket event **ditolak** (dikonfirmasi 15 Sep) | Tidak ada baris `voucher_products` (kursus baru yang terbit setelah voucher dikirim tetap tercakup); aturannya di kode: `validate()` menolak produk tiket event untuk voucher `campaign = 'FIRST_PURCHASE'` (§4.4) |
| P8 | Nilai, cap, dan masa berlaku **ditentukan tim internal lewat backoffice**, bukan oleh tim dev; diatur di level program, bukan per kode | Setting `type`, `value`, `maxAmount`, `validityDays` **tanpa default bisnis** (seed kosong). Program tidak bisa dinyalakan sebelum semuanya terisi. Baris voucher menyalin nilai saat diterbitkan, jadi mengubah setting tidak mengubah voucher yang sudah dikirim |
| P9 | Program **ship dalam keadaan mati**; yang menyalakan **tim internal dari backoffice**, kapan pun mereka siap | Job tidak berjalan sama sekali kalau mati atau `launchAt` kosong. Tidak ada tanggal rilis produk yang harus disepakati dengan dev |
| P10 | **Email dulu; kalau member tidak punya email, kirim lewat WhatsApp** (diputuskan 15 Sep). Dilewati hanya kalau tidak punya keduanya | Kanal `whatsapp` bb-comms (Qontak) sudah dipakai OTP; butuh **satu template WhatsApp baru yang disetujui Meta** (§7.2). Penting: member yang daftar **lewat HP di sistem baru** juga tidak punya email, jadi ini bukan hanya kasus legacy |
| P11 | Kalau pembelian pertama di-refund, voucher **tidak dicabut** (fase 1) | Refund jarang dan manual; pencabutan = task S terpisah kalau ternyata disalahgunakan |
| P12 | Kirim ulang email dari backoffice **boleh**; edit nilai per voucher dan buat manual per member **tidak** | Kebutuhan CS "belum dapat vouchernya" terlayani. Kasus khusus per orang tetap lewat halaman Voucher biasa dengan kode publik |

Tim dev **tidak** menetapkan nilai voucher. Angka yang dipakai di dokumen ini (10 %, Rp 50.000, 30 hari) hanya contoh untuk QA staging.

---

## 2. Alur, ujung ke ujung

```
JALUR BARU                                          JALUR LEGACY (Tribelio)
member bayar di app / shop.brainboost.id            member bayar di Tribelio
        │ webhook Xendit                                    │ course_enrollment (MariaDB)
        ▼                                                   ▼
commerce_transactions.status = PAID                 resync-worker (tiap jam) → course_enrollment
course_enrollment dibuat (listener yang ada)        (legacy_id != null, date_start = created legacy)
        │                                                   │
        └──────────────────┬────────────────────────────────┘
                           ▼
        job firstPurchaseVoucher  (bb-cron, tiap jam; mati kalau enabled=false)
          1. kandidat = pembelian kursus berbayar dengan waktu ≥ launchAt, sejak sweep terakhir
          2. "pertama"  = member tidak punya pembelian kursus berbayar lain yang lebih tua (kedua sumber)
          3. belum punya voucher FIRST_PURCHASE  (unique guard = idempoten)
          4. kanal = email kalau ada members.email, else whatsapp kalau ada phone, else skip + catat
          5. INSERT vouchers (owner, campaign, quota 1, ends_at = now + validityDays)
          6. enqueueComms({ type: 'FirstPurchaseVoucher', channel, refId: voucher.id })
                           │
                           ▼
        bb-comms: email "Kode voucher kamu: XXXXXXXX, berlaku sampai <tgl WIB>" + CTA shop.baseUrl
                           │
                           ▼
        member checkout produk apa pun → input kode → validate(): aktif, belum lewat, quota, OWNER == member
                           │ bayar
                           ▼
        commerce.payment.success → VoucherService.redeem() (jalur yang sudah ada, idempoten per order)
```

Satu titik penerbitan (job) dipilih ketimbang dua hook (listener pembayaran + syncer) karena: (a) aturan "pertama" harus melihat **kedua** sumber sekaligus — sebuah hook di satu jalur tidak tahu jalur lain; (b) `resync-worker` sengaja hanya bergantung pada `@bb/common` dan akan dihapus setelah cutover, jadi logika bisnis tidak boleh ditanam di sana; (c) job sweep idempoten secara alami. Harga yang dibayar: email datang **paling lambat 1 jam** setelah bayar, bukan seketika — untuk voucher "pembelian berikutnya" ini justru bagus, tidak bertabrakan dengan email struk.

---

## 3. Kondisi sekarang yang dipakai ulang

| Sudah ada | Dipakai untuk |
|---|---|
| `vouchers` + `voucher_products` + `voucher_redemptions` (`packages/domain/src/commerce/voucher.service.ts`) | Baris voucher, quota, redeem idempoten per order. **Tidak ada perubahan** di `redeem()` |
| `VoucherService.validate(code, productId, memberId)` — sudah menerima `memberId` untuk aturan TRIAL | Tempat satu-satunya cek pemilik (P2) |
| `commerce_transactions` (`status`, `paid_at`, `total`, `product_id`) | Kandidat jalur baru |
| `course_enrollment` (`legacy_id`, `date_start`, `expired_date`, `is_canceled`) diisi resync | Kandidat jalur legacy. `date_start` = `created` legacy, **bukan** `created_at` Postgres — penting supaya repair run `pnpm resync enrollments --since=1970…` tidak membawa baris lama lolos filter `launchAt` |
| `app_settings` + `SettingsService` / `SETTING_KEYS` | Konfigurasi program tanpa redeploy; backoffice sudah menulis `app_settings` untuk `shop.baseUrl` |
| `enqueueComms()` (`packages/common/src/services/comms-outbox.ts`) + bb-comms | Email; pola sama dengan `CoursePaymentSuccess` |
| `jobs-runner.ts` + `ecosystem.config.js` + `infra/cdk/lib/bb-ecs-stack.ts` | Job per jam. **Ketiganya** harus ditambah namanya — job yang tidak ada di daftar argv tidak pernah jalan dan tidak pernah error |
| `isEventTicketOrder(productId)` | Mengecualikan tiket dari "pembelian pertama" (P6) |
| `formatDateWib` (backend) / `formatDateWIB` (bb-comms) | Tanggal kedaluwarsa di email |
| Backoffice: `lib/voucher-queries.ts`, permission `vouchers.*`, pola "kirim ulang email" di halaman peserta event | Filter `campaign IS NULL`; menu baru meniru pola yang ada |

---

## 4. Keputusan desain

### 4.1 Definisi "pembelian kursus berbayar" (P6)

Dua sumber, satu bentuk `{ memberId, at }`:

| Sumber | Syarat | `at` |
|---|---|---|
| Baru | `commerce_transactions.status = 'PAID'`, `total > 0` (menyingkirkan trial dan voucher 100 %), produk **bukan** tiket event | `paid_at` |
| Legacy | `course_enrollment.legacy_id IS NOT NULL`, `expired_date IS NULL` (bukan trial), `is_canceled = false`, kursus → `products.price > 0` | `date_start` |

Residual yang **diterima**: enrollment yang di-grant admin di Tribelio pada kursus berbayar (tanpa baris pembayaran) ikut dihitung. Resync tidak membawa status pembayaran ke Postgres, dan menambah kolom hanya untuk ini tidak sepadan; dampaknya satu voucher diskon ke orang yang tidak membayar — bukan kebocoran uang.

### 4.2 Definisi "pertama" + cutoff (P5)

Member M memenuhi syarat jika ada pembelian P dengan `P.at >= launchAt` **dan** tidak ada pembelian lain milik M (dari sumber mana pun) dengan `at < P.at`. Member yang punya pembelian pra-launch tidak pernah memenuhi syarat. Job menyimpan watermark sweep (`app_settings` key `firstPurchaseVoucher.lastSweepAt`, atau tabel `sync_state`-style) dengan overlap 1 jam supaya baris yang terlambat masuk (resync jalan setelah job) tidak terlewat; unique guard (4.3) yang menjaga tidak ada duplikat.

### 4.3 Baris voucher yang diterbitkan

```
code             8 karakter [A-Z0-9] tanpa 0/O/1/I, retry kalau unique violation
type / value / max_amount   disalin dari setting saat terbit (P8)
quota = 1, used = 0, is_active = true
starts_at = now(), ends_at = now() + validityDays
owner_member_id = member, campaign = 'FIRST_PURCHASE', owner_source = 'APP' | 'LEGACY'
voucher_products: kosong (global, P7)
```

Partial unique `(owner_member_id, campaign) WHERE owner_member_id IS NOT NULL` (P4). Insert voucher + enqueue email dalam satu transaksi; kalau enqueue gagal, baris voucher ikut batal dan sweep berikutnya mengulang.

### 4.4 Cek pemilik di checkout (P2)

Di `validate()`, setelah cek aktif/masa/quota yang ada:

```
if (voucher.ownerMemberId && voucher.ownerMemberId !== memberId)
  return { valid: false, reason: 'Voucher invalid' }   // errorCode default VOUCHER_INVALID — generik, bukan oracle
if (voucher.campaign === 'FIRST_PURCHASE' && !(await isFullCourseProduct(productId)))
  return { valid: false, reason: 'Voucher hanya berlaku untuk kursus penuh', errorCode: VOUCHER_COURSE_ONLY }
```

Cek kedua boleh spesifik: yang mencoba adalah pemilik sah, jadi pesannya harus menjelaskan, bukan menyembunyikan. `VOUCHER_COURSE_ONLY` = error code baru (ditambah di `ERROR_CODES`), FE menampilkan `reason`. Scope kursus ditegakkan di kode, bukan lewat `voucher_products`, supaya kursus yang terbit setelah voucher dikirim tetap bisa dibeli dengan voucher itu. Sejak 2026-09-25 scope itu = `products.type === 'course'` saja; `mini_course` ditolak (lihat §14). Voucher tanpa pemilik berperilaku persis seperti sekarang. `redeem()` tidak berubah: quota 1 + `voucher_redemptions` sudah menjamin sekali pakai per order, dan pemilik sudah dipastikan di `validate()` sebelum order dibuat.

### 4.5 Laporan tanpa tabel baru

| Angka | Sumber |
|---|---|
| Diterbitkan | `vouchers WHERE campaign = 'FIRST_PURCHASE'` (per bulan `created_at`, per `owner_source`) |
| Dipakai + omzet | `voucher_redemptions` ⋈ `commerce_transactions` (`status = PAID`), `SUM(total)`, `SUM(voucher_amount)` |
| Kedaluwarsa tanpa dipakai | `ends_at < now() AND used = 0` |
| Konversi | dipakai ÷ diterbitkan |
| Per kanal (email / WhatsApp) | `vouchers.sent_channel` (§5) |
| Dilewati (tanpa email dan tanpa HP) | dihitung job, dicatat log `first_purchase_voucher.skipped_no_contact`; angka disimpan di stats job supaya bisa ditampilkan |

---

## 5. Data model

Satu migration, aditif, tanpa downtime.

```sql
ALTER TABLE vouchers
  ADD COLUMN owner_member_id UUID NULL,          -- tanpa FK (pola AffiliateAttributionClaim); member hapus akun tidak boleh gagal karena voucher
  ADD COLUMN campaign        TEXT NULL,          -- 'FIRST_PURCHASE'; NULL = voucher biasa buatan ops
  ADD COLUMN owner_source    TEXT NULL,          -- 'APP' | 'LEGACY'; hanya untuk laporan
  ADD COLUMN sent_channel    TEXT NULL;          -- 'email' | 'whatsapp'; kanal yang dipilih saat terbit

CREATE UNIQUE INDEX vouchers_owner_campaign_uq
  ON vouchers (owner_member_id, campaign) WHERE owner_member_id IS NOT NULL;
CREATE INDEX vouchers_campaign_created_idx ON vouchers (campaign, created_at);
```

`app_settings` (seed, semua nilai string):

| Key | Default seed | Keterangan |
|---|---|---|
| `firstPurchaseVoucher.enabled` | `false` | Saklar program (P9) |
| `firstPurchaseVoucher.launchAt` | *(kosong)* | ISO datetime; job tidak jalan kalau kosong. Diisi backoffice saat pertama kali menyalakan |
| `firstPurchaseVoucher.type` | *(kosong)* | `PERCENT` \| `AMOUNT`; diisi tim internal (P8) |
| `firstPurchaseVoucher.value` | *(kosong)* | |
| `firstPurchaseVoucher.maxAmount` | *(kosong)* | cap untuk PERCENT; boleh kosong = tanpa cap |
| `firstPurchaseVoucher.validityDays` | *(kosong)* | |

`SETTING_KEYS` di `packages/common/src/services/settings.service.ts` ditambah enam entri di atas.

---

## 6. Backend (`packages/domain` + `apps/mobile-api`)

- **Job** `packages/domain/src/jobs/first-purchase-voucher.ts` — `firstPurchaseVoucher(opts?: { memberId?: string; dryRun?: boolean })`. `memberId` untuk QA satu akun (pola `streakReminder`), `dryRun` mencetak kandidat tanpa menulis. Didaftarkan di `jobs-runner.ts` **dan** `ecosystem.config.js` **dan** `bb-ecs-stack.ts`.
- **Issuer** `packages/domain/src/commerce/first-purchase-voucher.service.ts` — `issueForMember(memberId, source)`: buat baris + enqueue dalam satu transaksi; dipakai job dan (lewat SQL insert ke outbox) tombol kirim ulang tidak perlu — kirim ulang cukup enqueue lagi dengan `refId` yang sama.
- **`VoucherService.validate()`** — cek pemilik (4.4).
- **Tidak ada endpoint baru.** Checkout memakai `voucherCode` yang sudah ada. Serializer voucher di respons checkout tidak mengekspos `owner_member_id`.

## 7. bb-comms — `[COMMS]`

Jenis pesan baru `FirstPurchaseVoucher`, `refId = vouchers.id`, kanal `email` **atau** `whatsapp` (dipilih backend, §2 langkah 4). Handler membaca `vouchers` ⋈ `members` (nama, email, phone + phone_code) dan menampilkan: kode, nilai, berlaku sampai `ends_at` dalam **WIB**, dan **satu kalimat scope**: "Berlaku untuk pembelian kursus di shop.brainboost.id" (bukan tiket event, bukan di Tribelio — P1, P7). **Deploy bb-comms sebelum backend** — jenis pesan tak dikenal masuk DLQ.

### 7.2 Kanal WhatsApp (P10)

Yang sudah ada di bb-comms (`internal/channel/whatsapp.go`): OAuth Qontak + `POST /api/open/v1/broadcasts/whatsapp/direct` dengan `message_template_id`, variabel body, dan tombol URL — dipakai OTP. Pesan voucher = panggilan yang sama dengan template lain, jadi pekerjaannya kecil: generalisasi `SendOTP` menjadi `SendTemplate(templateID, to, name, bodyVars, buttonURL)` + satu env `QONTAK_FIRST_PURCHASE_VOUCHER_TEMPLATE_ID`.

Yang **tidak** ada di kode dan jadi jalur terpanjang: **template WhatsApp harus disetujui Meta lewat dashboard Qontak sebelum bisa dikirim.** Isi template ditentukan tim internal (teks tetap + variabel `{{1}}` nama, `{{2}}` kode, `{{3}}` nilai, `{{4}}` tanggal kedaluwarsa, tombol URL ke `shop.baseUrl/login?identifier=<phone>&next=/products`). Kategori kemungkinan **MARKETING** (isinya penawaran diskon), yang: (a) ditagih per pesan lebih mahal dari kategori authentication yang dipakai OTP; (b) tunduk pada aturan opt-in Meta — nomor diberikan saat daftar, tapi S&K harus mencakup pesan promosi; (c) **memengaruhi quality rating nomor bisnis yang sama dengan OTP** — laporan/blokir dari penerima bisa menurunkan rating dan membatasi kiriman, termasuk OTP. Karena itu WhatsApp di sini **fallback saja** (hanya member tanpa email), bukan kanal utama, dan tidak ada pengiriman ulang otomatis.

Nomor legacy tidak pernah diverifikasi (`is_phone_verified` false untuk baris resync), jadi ada peluang pesan nyasar ke nomor salah ketik. Dampaknya hanya satu pesan nyasar: voucher terkunci ke `owner_member_id`, penerima yang salah tidak bisa memakainya.

### 7.1 Varian `owner_source = 'LEGACY'`: pembeli yang belum pernah menyentuh sistem baru

**Pembeli pertama dari Tribelio hampir pasti belum ada di Postgres sebelum pembeliannya.** `migrate-members` hanya membawa member yang punya `course_enrollment` kursus Brainboost, menerima komisi, atau ada di pohon affiliate — member yang belum pernah beli tidak pernah dimigrasi, dan members syncer hanya menyentuh yang sudah ada (`member_id IN (…)`). Yang menutupnya adalah `ensureMember` di syncer enrollment (`apps/resync-worker/src/ensure-member.ts`): saat enrollment pertamanya masuk, member dibuat **saat itu juga** dari baris `member` legacy (email, password hash + algo terdeteksi, `isActive`, Google/Apple sub, dedup ke akun yang sudah ada by email/phone/sub), lalu backfill akhir run menautkannya ke dua community network. Jadi baris member dan baris enrollment lahir di tick resync yang sama, sebelum job voucher melihatnya. Dua kasus yang tidak lolos, keduanya memang tidak bisa dikirimi email: baris legacy tanpa email/phone/sub sama sekali (dilewati `ensureMember`, tidak ada enrollment), dan email buatan `@brainboost.id` (di-null-kan → identitas phone → dilewati P10). Konsekuensinya: segmen LEGACY **secara definisi** adalah akun yang baru lahir di sistem baru dan belum pernah login di mana pun selain Tribelio — persoalan onboarding di bawah bukan kasus tepi, tapi seluruh segmen.

Apa yang sudah benar tanpa kerja tambahan (diverifikasi di kode 15 Sep):

- Akunnya **sudah ada** di Postgres lewat resync members: email, `password_hash`, dan `password_algo` yang dideteksi dari bentuk hash (md5/bcrypt), jadi **email + password Tribelio langsung bisa dipakai** di `shop.brainboost.id/login`. Login form web menerima email atau nomor HP.
- Akun Tribelio yang masuk lewat **Google** juga jalan: gate link sosial mengecualikan baris ber-`legacyId`, jadi tombol "Lanjutkan dengan Google" di web menautkan ke akun lama by email, bukan membuat akun baru.
- Login page membaca `?identifier=<email>` untuk prefill dan `?next=` untuk tujuan setelah login, jadi CTA email bisa langsung `shop.baseUrl/login?identifier=<email>&next=/products` — tanpa kerja marketplace.

Satu lubang nyata: **marketplace tidak punya halaman lupa password.** Login form hanya punya password + Google. Backend-nya ada (`/auth/requestForgotPassword` → `/auth/forgotPasswordVerification`, dipakai app mobile), tapi tidak ada UI web. Pembeli Tribelio yang lupa password dan bukan pengguna Gmail **buntu**: satu-satunya jalan reset adalah memasang aplikasi. Untuk segmen "belum pernah login di sistem baru", ini kasus yang justru sering.

Tiga tingkat, pilih satu:

| Tingkat | Isi | Kerja | Catatan |
|---|---|---|---|
| A. Copy saja | Satu paragraf: "Masuk di shop.brainboost.id dengan email dan password akun Brainboost kamu. Kalau daftar lewat Google, pakai tombol Google." + CTA prefilled | 0 dev di luar template | Lupa password tetap buntu di web |
| **B. Copy + halaman lupa password web (usulan)** | Sama dengan A, ditambah link "Lupa password?" di login form web → halaman request OTP email → verifikasi → password baru, memakai dua endpoint backend yang sudah ada | MP task S–M, tidak ada backend | Menutup lubang untuk semua pengguna web, bukan hanya penerima voucher |
| C. Magic link (token login di email) | Klik email = langsung masuk | Permukaan auth baru: email jadi kredensial login | **Ditolak**: `?t=` di tiket event sengaja hanya membuka satu halaman order, bukan sesi; magic link membalik keputusan itu |

Usulan: **B**. Halaman lupa password adalah utang marketplace yang sudah ada sebelum fitur ini, dan program ini yang pertama kali mengarahkan ribuan pengguna lama ke login web. Kalau B ditunda, A tetap jalan dan laporan (klik CTA vs login sukses) yang akan menunjukkan seberapa besar lubangnya.

## 8. Backoffice (`backoffice-bb`) — `[BO]`

Menu baru **Voucher Pembeli Pertama** di grup Marketing, permission baru `firstPurchaseVoucher.view` / `.manage`. Tiga bagian dalam satu halaman (tab):

1. **Pengaturan program** — tipe, nilai, cap, masa berlaku, lalu saklar aktif. Saklar **terkunci** sampai keempat nilai terisi. Menyalakan pertama kali mengisi `launchAt = now()` otomatis (ditampilkan, tidak bisa dimundurkan). Menulis ke `app_settings` (pola `shop.baseUrl`), audit log.
2. **Ringkasan** — kartu: diterbitkan, dipakai, konversi, omzet dari order ber-voucher, kedaluwarsa tanpa dipakai, dilewati tanpa email. Filter bulan terbit + sumber (APP / LEGACY). Query di §4.5.
3. **Daftar per member** — cari nama/email/kode; kolom: member, kode, sumber, terbit, berlaku sampai, status (aktif / dipakai + tanggal + order / kedaluwarsa); tombol **Kirim ulang email** (enqueue `FirstPurchaseVoucher` lagi, `.manage`).

Perubahan di halaman Voucher yang ada: `getVouchers()`, `listVoucherOptions()`, dan summary-nya ditambah `WHERE v.campaign IS NULL`. `getVoucherDetail(id)` dibiarkan (akses by id, dipakai link dari daftar per member).

---

## 9. Task breakdown

Ukuran: S ≤ 1 hari, M 2–3 hari, L 4–5 hari.

### Backend (repo ini) — `[BE]`

| ID | Task | Acceptance | Ukuran | Tergantung |
|---|---|---|---|---|
| BE-01 | Migration: 3 kolom `vouchers`, partial unique, index; 6 key `SETTING_KEYS` + seed | `prisma migrate diff` no drift; seed idempoten; `enabled=false` dan nilai program kosong setelah seed | S | — |
| BE-02 | Cek pemilik + scope kursus di `VoucherService.validate()`; error code `VOUCHER_COURSE_ONLY` | Table-driven test: tanpa owner = perilaku lama byte-for-byte; owner ≠ member → `VOUCHER_INVALID` generik; owner = member + kursus → valid; owner = member + tiket event → `VOUCHER_COURSE_ONLY` | S | BE-01 |
| BE-03 | Issuer `issueForMember` + generator kode | Insert + enqueue satu transaksi; unique violation kode → retry; unique `(owner, campaign)` → no-op; member tanpa email → skip + log | S | BE-01 |
| BE-04 | Job `firstPurchaseVoucher`: kandidat dua sumber (§4.1), aturan pertama + cutoff (§4.2), pilihan kanal email → whatsapp → skip, watermark + overlap, `memberId` / `dryRun` | Integration test (Postgres asli): (a) order PAID pertama pasca-launch → 1 voucher; (b) member dengan enrollment pra-launch → 0; (c) trial (`total=0` / `expired_date`) → 0; (d) tiket event → 0; (e) enrollment legacy `date_start` pasca-launch → 1 dengan `owner_source=LEGACY`; (f) member kena dua jalur → tetap 1; (g) job dijalankan dua kali → tidak ada duplikat; (h) `enabled=false` atau `launchAt` kosong → tidak menulis apa pun; (i) member tanpa email + ada HP → `sent_channel=whatsapp`; tanpa keduanya → skip | M | BE-03, COMMS-01 |
| BE-05 | Daftarkan job di `jobs-runner.ts`, `ecosystem.config.js`, `bb-ecs-stack.ts` | Job muncul di lane cron per jam di staging; log satu baris ringkasan per tick | S | BE-04 |

### bb-comms — `[COMMS]`

| ID | Task | Acceptance | Ukuran | Tergantung |
|---|---|---|---|---|
| COMMS-01 | Jenis pesan `FirstPurchaseVoucher` kanal email: template HTML, tanggal WIB, kalimat tambahan untuk `LEGACY`, CTA `shop.baseUrl` | Render snapshot test dua varian; deploy **sebelum** BE-05 ke prod | S–M | — |
| COMMS-02 | Kanal WhatsApp untuk jenis pesan yang sama: generalisasi `SendOTP` → `SendTemplate`, env template ID, handler branch `channel == whatsapp` membaca phone + phone_code → E.164 | Kirim uji ke nomor tim dengan template yang sudah disetujui; tanpa env → dev no-op seperti OTP | S | OPS-03 |

### Marketplace — `[MP]` (hanya jika §7.1 tingkat B dipilih)

| ID | Task | Acceptance | Ukuran | Tergantung |
|---|---|---|---|---|
| MP-01 | Link "Lupa password?" di login form + halaman request OTP email → verifikasi → password baru, memakai `/auth/requestForgotPassword` + `/auth/forgotPasswordVerification` | Akun legacy (md5) bisa reset lalu login; cooldown/`retryAfterSeconds` ditampilkan; tidak membocorkan apakah email terdaftar | S–M | — |

### Backoffice — `[BO]`

| ID | Task | Acceptance | Ukuran | Tergantung |
|---|---|---|---|---|
| BO-01 | Filter `campaign IS NULL` di `getVouchers`, `listVoucherOptions`, summary halaman Voucher | Voucher pembeli pertama tidak tampil di list/dropdown; total halaman Voucher tidak berubah dari sebelum fitur | S | BE-01 |
| BO-02 | Menu + permission + tab Pengaturan program (tulis `app_settings`, audit) | Saklar terkunci sampai tipe/nilai/cap/masa berlaku terisi; menyalakan pertama kali mengisi `launchAt` dan tidak bisa dimundurkan; nilai terbaca `SettingsService` ≤ 60 dtk | M | BE-01 |
| BO-03 | Tab Ringkasan (§4.5) dengan filter bulan + sumber | Angka cocok dengan query manual di staging | M | BO-02 |
| BO-04 | Tab Daftar per member + Kirim ulang email | Cari by email menemukan; kirim ulang menghasilkan 1 baris outbox baru, tercatat di audit | M | BO-02, COMMS-01 |

### Ops

| ID | Task |
|---|---|
| OPS-01 | Urutan rilis: COMMS-01 → backend (BE-01…BE-05, migrasi aditif) → backoffice. Program tetap **mati** sampai produk menyalakan dari BO-02 |
| OPS-02 | QA staging: nyalakan program dengan `launchAt` = hari ini, beli satu kursus dengan akun uji, tunggu tick, cek email + coba pakai kode dengan akun lain (harus ditolak) dan akun sendiri (harus lolos) |
| OPS-03 | **Ajukan template WhatsApp ke Meta lewat Qontak di hari pertama sprint** — teks dari tim internal, kategori + opt-in dikonfirmasi; persetujuan Meta biasanya hitungan hari dan tidak bisa dipercepat dari sisi dev |

Jalur kritis: BE-01 → BE-03 → BE-04 → BE-05. Backoffice paralel setelah BE-01; bb-comms dan marketplace paralel sejak awal. Total kira-kira **5–6 hari backend, 1–2 hari comms, 5–6 hari backoffice, 1–2 hari marketplace (opsional)** — muat satu sprint untuk dua engineer.

---

## 10. Out of scope (fase 1)

- Pencabutan voucher saat pembelian pertama di-refund (P11).
- Backfill ke pembeli sebelum `launchAt` (P5).
- Voucher pembeli pertama yang bisa dipakai di checkout Tribelio (P1 — secara arsitektur tidak mungkin tanpa sync dua arah).
- Voucher untuk tiket event, dan tiket event sebagai pemicu (P6, P7).
- Magic link login dari email (§7.1 tingkat C).
- Program otomatis lain (ulang tahun, reaktivasi). Kolom `campaign` sengaja teks bebas supaya program berikutnya tinggal menambah nilai, bukan skema.
- Pengingat "voucher kamu kedaluwarsa 3 hari lagi" (butuh sent-marker; sama dengan gap pengingat trial yang sudah dikenal).

## 11. Risiko

| Risiko | Mitigasi |
|---|---|
| `launchAt` di masa lalu → email massal ke ribuan pembeli lama | `launchAt` hanya diisi sistem saat program dinyalakan dan tidak bisa dimundurkan dari UI (P5). Job juga membatasi satu tick maksimal N penerbitan (mis. 500) dan mencatat sisanya ke tick berikut |
| Job dan resync berjalan hampir bersamaan → enrollment legacy masuk setelah sweep | Overlap watermark 1 jam + unique guard; baris terlambat tertangkap di tick berikut tanpa duplikat |
| Kode voucher pribadi bocor lewat screenshot / diteruskan | `validate()` menolak member lain (P2); jawaban generik supaya tidak jadi oracle |
| Enrollment grant admin di Tribelio dihitung sebagai pembelian | Diterima (§4.1); nilainya satu diskon, bukan uang keluar |
| bb-comms belum deploy saat backend mulai enqueue | Urutan rilis OPS-01; pesan tak dikenal masuk DLQ dan bisa di-replay setelah comms naik |
| Template WhatsApp belum disetujui Meta saat program dinyalakan | Handler WhatsApp tanpa template ID = no-op + log (pola dev no-op OTP); pesan tidak hilang karena `sent_channel` tercatat dan bisa dikirim ulang dari backoffice setelah template disetujui |
| Pesan promosi menurunkan quality rating nomor WhatsApp yang juga dipakai OTP | WhatsApp hanya fallback untuk member tanpa email, satu pesan per member seumur hidup, tanpa kirim ulang otomatis; pantau rating di dashboard Qontak minggu pertama |
| Halaman Voucher backoffice lupa difilter → ribuan baris muncul | BO-01 adalah task terpisah dengan acceptance eksplisit; masuk jalur rilis sebelum program dinyalakan |

## 12. Pertanyaan terbuka untuk produk

Sudah dijawab 15 Sep: nilai voucher diset tim internal dari backoffice (P8); penerima hanya pembeli setelah program dinyalakan (P5); voucher hanya untuk kursus (P7); pemicu hanya kursus (P6).

| # | Pertanyaan | Usulan |
|---|---|---|
| D-4 | Onboarding pembeli Tribelio di email: tingkat A (copy saja) atau B (+ halaman lupa password web)? Lihat §7.1 | **B** — utang marketplace yang sudah ada, dan program ini yang pertama mengarahkan pengguna lama ke login web |

---

## 13. Temuan review kode (15 Sep 2026)

PRD di atas ditulis sebelum desainnya diadu dengan kode. Bagian ini adalah hasil pembacaan
`packages/domain/src/commerce/`, `apps/mobile-api/src/modules/{commerce,ingest}/`,
`apps/resync-worker/src/syncers/enrollments.ts`, `prisma/schema.prisma`, dan lane cron.
Pernyataan di §0–§12 **tidak** diedit; yang di bawah ini yang berlaku kalau keduanya bentrok.

Ringkasnya: desainnya cocok. `redeem()`, `voucher_redemptions`, `computeTotals()`,
`enqueueComms()`, dan lane `bb-cron` semuanya dipakai apa adanya. Enam hal di bawah harus
dibetulkan sebelum BE-01 dimulai.

### 13.1 Kolom `commerce_transactions.total` tidak ada

Skemanya punya `item_total`, `voucher_amount`, `fee_total`, dan `amount` (grand total).
§4.1 (`total > 0`) dan §4.5 (`SUM(total)`) keduanya harus `amount`.

Semantiknya kebetulan sudah benar: voucher-bypass 100 % dan TRIAL settle lewat
`payment.service.ts` dengan `amount: 0` dan baru kemudian `status = 'PAID'`, jadi
`amount > 0` sudah menyingkirkan keduanya persis seperti yang P6 minta — tapi lewat kolom
yang bernama lain.

### 13.2 Partial unique index tidak diperlukan, dan bikin BE-01 gagal acceptance-nya sendiri

Prisma tidak bisa mengekspresikan `CREATE UNIQUE INDEX … WHERE`, jadi index seperti di §5
hanya bisa ditulis sebagai SQL mentah dan `prisma migrate diff` akan melaporkannya sebagai
drift — bertabrakan dengan acceptance BE-01 ("no drift"). Repo ini belum punya satu pun
partial index; preseden yang ada (`CHECK` di `20260820120000_voucher_trial`) lolos justru
karena Prisma mengabaikan CHECK, dan itu tidak berlaku untuk index.

`WHERE`-nya memang mubazir. Postgres memperlakukan NULL sebagai distinct di unique index,
jadi `@@unique([ownerMemberId, campaign])` polos sudah memberi jaminan yang sama: voucher
ops (owner NULL) tetap tak terbatas, satu member tetap terkunci satu baris `FIRST_PURCHASE`.
Nol SQL mentah, nol drift.

### 13.3 Sumbernya tiga, bukan dua

`apps/mobile-api/src/modules/ingest/purchase-ingest.service.ts` menulis baris
`commerce_transactions` dengan `status: 'PAID'`, `amount: <gross>`, dan `provider != null`
untuk IAP / Scalev / Lynk.id — tabel yang sama yang disapu jalur baru. Query kandidat di §4.1
ikut menariknya tanpa menyebutnya.

Harus diputuskan eksplisit, bukan dibiarkan jadi akibat sampingan: ikut dihitung (pembeli
IAP menerima voucher yang hanya bisa dipakai di web — cross-channel, kemungkinan justru
yang diinginkan) atau dibuang dengan `provider IS NULL`. Keduanya sah; yang tidak sah adalah
tidak memilih.

### 13.4 "Bukan tiket event" bukan definisi yang sama dengan "kursus"

Bukti bahwa sebuah produk bisa di-enroll di repo ini adalah **adanya baris `course`**
(`product.course != null`), bukan nilai `type`. Ini pelajaran yang sudah dibayar sekali:
`payment-success.listener.ts` mencatat bahwa gate lama `type === 'course'` diam-diam
membuang pembelian `mini_course` — komisi tercatat, enrollment tidak pernah diberikan.

Jadi jalur baru harus memakai whitelist (produk yang punya baris `course`), bukan blacklist
tipe. Dengan blacklist, SKU jenis baru yang terbit nanti (subscription, misalnya) otomatis
memicu voucher tanpa siapa pun memutuskannya.

### 13.5 Jawaban "generik" di §4.4 masih jadi oracle

`POST /api/member/payment/voucher/validate` mengembalikan seluruh objek hasil ke klien
(`commerce.controller.ts` → `ok(res, result)`; `VoucherValidateResultDto` hanya dokumentasi
OpenAPI, bukan serializer), `reason` termasuk. §4.4 menulis `reason: 'Voucher invalid'`,
sementara cabang tidak-ketemu yang sudah ada menjawab `'Voucher not found'` — dua string
berbeda, jadi penyerang tetap belajar "kode ini ada, cuma bukan punyaku", yang justru satu-
satunya hal yang disembunyikan.

Supaya benar-benar bukan oracle, cabang owner harus mengembalikan objek yang **identik**
dengan cabang not-found, bukan sekadar pesan yang sama-sama kabur. Endpoint-nya sudah
`authGuard` + `voucherValidateRateLimiter` (20 per window, key per user), jadi biaya
probing nyata — tapi bukan nol, dan rate limit bukan pengganti jawaban yang tidak membedakan.

Cek kedua (scope kursus) tetap boleh spesifik seperti di §4.4: yang mencoba adalah pemilik
sah. `VOUCHER_COURSE_ONLY` harus ditambahkan di **dua** file — `error-codes.ts` dan
`error-messages.ts` (repo menyimpan dua map paralel).

### 13.6 `SETTING_KEYS` dan seed adalah dua daftar terpisah

`prisma/seed-settings.ts` menuliskan sendiri string key-nya dan tidak mengimpor
`SETTING_KEYS`. BE-01 karena itu menambah enam entri di **dua** tempat, bukan satu.

### 13.7 Koreksi klaim §4.1 soal status pembayaran legacy

§4.1 menyatakan "resync tidak membawa status pembayaran ke Postgres". Setengah benar:
syncer **membacanya** — `enrollments.ts` mem-JOIN `course_payment` dan
`product_bundle_payment` lalu menolak baris yang bukan `SUCCESS` — ia hanya tidak menyimpan
bedanya. Jadi baris yang sampai di Postgres adalah `SUCCESS` **atau** tanpa baris pembayaran
sama sekali.

Residual "enrollment grant admin ikut dihitung" karena itu persis kasus kedua
(`cp IS NULL AND bp IS NULL`), dan kalau suatu saat dianggap layak ditutup, harganya satu
kolom nullable di `course_enrollment` — bukan "datanya tidak ada di hulu". Keputusan
menerimanya tetap masuk akal; alasannya yang perlu diperbaiki.

### 13.8 Prasyarat rilis: repair run enrollment harus jalan lebih dulu

Filter `is_canceled = false` di §4.1 benar dan load-bearing. Yang membuatnya berfungsi adalah
perubahan yang memetakan `status = 0` legacy (soft-delete Cresenity) menjadi
`isCanceled = true`, `cancelationReason = 'legacy_removed'`. Baris yang sudah terlanjur bocor
sebelum perubahan itu duduk di bawah watermark selamanya dan hanya diperbaiki oleh satu
paksaan manual:

```
pnpm resync enrollments --since=1970-01-01T00:00:00Z     # dry-run dulu; terukur voided=3240
```

Kalau program voucher dinyalakan sebelum repair itu, ~3,2k enrollment yang sudah dihapus di
Tribelio masih terbaca LIVE dan ikut jadi "pembelian pertama". Masukkan ke OPS-01 sebagai
langkah sebelum BE-05, bukan catatan kaki.

### 13.9 Konfirmasi yang meredakan dua kekhawatiran

- **Cek P7 bukan kode mati.** Event checkout memang menerima `voucherCode` dan menjalankannya
  lewat `CheckoutService.start()` → `validate()`, jadi penolakan tiket event di `validate()`
  benar-benar terpasang di jalur beli, bukan cuma di endpoint validate. Catatan: di
  `event-checkout.service.ts` sudah ada preseden gate tipe voucher untuk event
  (`assertNotTrialVoucher`). Jangan diduplikasi — cek campaign cukup di `validate()`, yang
  sekaligus menutup endpoint validate publik yang `assertNotTrialVoucher` tidak sentuh.
- **Enqueue di dalam transaksi memang didukung.** `enqueueComms(input, tx)` menerima
  transaction client, jadi "insert voucher + enqueue email dalam satu transaksi" (§4.3)
  bukan asumsi.
- **Watermark.** `sync_state` ada di skema root, tapi tabel itu milik `apps/resync-worker`
  yang dihapus setelah cutover. Pakai alternatif `app_settings` yang sudah disebut di §4.2.

### 13.10 Risiko kecil yang tidak disebut di §11

| Risiko | Penilaian |
|---|---|
| Backfill akhir-run resync mencakup kyc/tree/commissions/likes tapi **tidak** enrollments, jadi member yang dimaterialisasi on-demand hanya punya enrollment pemicunya di Postgres dan terbaca sebagai pembeli pertama | Kecil secara konstruksi: `migrate-members.ts` sudah menarik setiap member yang punya enrollment BB, jadi member on-demand memang tidak punya riwayat. Catat, jangan kerjakan |
| Hapus akun meninggalkan voucher yatim (`owner_member_id` tanpa FK — benar, pola `AffiliateAttributionClaim`) | Tidak berbahaya: `validate()` tidak akan pernah cocok lagi. Pastikan baris begini tidak dihitung "aktif" di §4.5 |
| `ecosystem.config.js` masih mendaftarkan `bb-backoffice-api` + `bb-admin-ejs` yang dihapus 2026-07 | Tidak nyambung dengan fitur ini, tapi BE-05 menyentuh file itu — sekalian bersihkan |

### 13.11 Ukuran

5–6 hari backend tetap masuk akal. BE-02 dan BE-03 memang S. BE-04 tetap M, dan bagian
terbesarnya adalah sembilan skenario test integrasi dengan Postgres asli, bukan query
kandidatnya. Jalur kritis sebenarnya tetap OPS-03 (approval template Meta), persis seperti
yang sudah dicatat PRD.

---

## 14. Status implementasi backend (15 Sep 2026)

BE-01…BE-05 **selesai** di repo ini. COMMS-01/02, BO-01…BO-04 dan MP-01 ada di repo lain
dan belum dikerjakan. Program **ship dalam keadaan mati** (P9): `enabled=false`, `launchAt`
kosong, empat nilai program kosong — tidak ada satu pun voucher yang bisa terbit sampai tim
internal mengisinya dari backoffice.

| Task | Berkas |
|---|---|
| BE-01 | `prisma/schema.prisma` (4 kolom + `@@unique` + `@@index` di `Voucher`), migrasi `20260915120000_first_purchase_voucher`, 7 key di `SETTING_KEYS`, 7 baris di `prisma/seed-settings.ts` |
| BE-02 | `packages/domain/src/commerce/voucher.service.ts`, `course-product.ts` (baru), `VOUCHER_COURSE_ONLY` di `error-codes.ts` + `error-messages.ts` |
| BE-03 | `packages/domain/src/commerce/first-purchase-voucher.service.ts` |
| BE-04 | `packages/domain/src/jobs/first-purchase-voucher.ts` |
| BE-05 | `apps/mobile-api/src/jobs-runner.ts`, `ecosystem.config.js`, `infra/cdk/lib/bb-ecs-stack.ts` |
| Test | `apps/mobile-api/tests/commerce/first-purchase-voucher.spec.ts` — 20 tes, Postgres asli |

### 14.1 Yang berbeda dari spesifikasi, dan alasannya

**Cek pemilik dijalankan PALING AWAL, bukan setelah cek aktif/masa/quota.** §4.4 menaruhnya
sesudah; urutan itu bocor. Menjawab `'Voucher expired'` untuk kode milik orang lain tetap
memastikan kodenya ada — satu-satunya hal yang disembunyikan. Voucher ber-pemilik harus
terlihat identik dengan kode yang tidak ada, di **setiap** keadaan yang bisa dialaminya.
Jawabannya sekarang satu konstanta `NOT_FOUND` yang dipakai kedua cabang, jadi keduanya tidak
bisa berpencar pelan-pelan. Ada tes yang membandingkan kedua objek dengan `toEqual`.

**Scope kursus ditegakkan dengan whitelist, bukan `isEventTicketOrder`.** §3 dan §4.4
menyebut `isEventTicketOrder`; itu blacklist, dan tipe produk berikutnya yang muncul lolos
secara default tanpa ada yang memutuskannya.

**Dipersempit 2026-09-25: `mini_course` TIDAK dapat diskon.** Helper `isCourseProduct`
(`product.course != null`) diganti `isFullCourseProduct` (`products.type === 'course'`).
Versi lama meloloskan mini course, karena mini course punya baris `courses`. Keputusan
produk: diskon hanya untuk kursus penuh. Bentuknya tetap whitelist satu tipe, jadi
`bundle`, `book`, `digital`, `event_ticket` dan tipe yang belum ada pun ikut tertolak.

Dua hal yang tidak boleh ikut berubah:

1. **Gate enrollment/akses tetap berbasis baris `courses`.** `payment-success.listener.ts`
   pernah memakai `type === 'course'` dan diam-diam membuang setiap pembelian
   `mini_course` — komisi tercatat, enrollment tidak. Pertanyaannya beda, jangan disamakan.
2. **Filter penerbitan (`PAID_COURSE_ORDER`) sengaja tetap lebih luas.** Ia menjawab
   "member ini sudah pernah beli apa pun belum?", dan pembeli mini course jelas sudah.
   Menyempitkannya ke `type = 'course'` akan membuat semua pembeli mini course lama
   terbaca sebagai pembeli baru dan dikirimi voucher bertahun-tahun terlambat. Ongkos
   asimetrinya ringan dan disengaja: pembeli mini course tetap menerima voucher, dan
   voucher itu bisa dipakai untuk kursus penuh.

**Unique-nya polos, bukan partial.** Lihat §13.2.

**Aturan "pertama" disederhanakan jadi satu perbandingan.** §4.2 menuliskannya sebagai "ada P
dengan `P.at >= launchAt` dan tidak ada pembelian lain dengan `at < P.at`"; itu ekuivalen
dengan "pembelian PALING AWAL milik member ada di atau setelah `launchAt`", yang cuma satu
`MIN()` per sumber. Bentuk itu juga yang membuat "tidak ada backfill ke pembeli lama" (P5)
terbaca langsung di kode.

**Sumber ketiga (IAP/Scalev/Lynk.id) ikut dihitung** — keputusan yang §13.3 minta dibuat
eksplisit. Membayar di dalam aplikasi tetap membayar, dan §2 memang menyebut "member bayar di
app". Yang menyaringnya bukan kolom `provider` tapi whitelist kursus: SKU langganan yang tidak
punya baris `course` tidak lolos, karena memang bukan pembelian kursus.

### 14.2 Yang ditambahkan dan tidak ada di spesifikasi

**Enrollment legacy tanpa `date_start` menggugurkan member-nya.** Baris seperti itu (zero-date
MySQL yang lolos migrasi) adalah pembelian yang umurnya TIDAK diketahui, dan `MIN()` akan
melangkahinya — membuat pembeli lama terbaca baru, persis kebocoran yang `launchAt` ada untuk
mencegah. Tidak bisa ditentukan = tidak diputuskan: member-nya dilewati. Ia kehilangan voucher
yang mungkin berhak, yang merupakan kesalahan yang lebih murah.

**Watermark ditahan pada tiga keadaan**, bukan cuma dry-run: batch yang kena cap
(`MAX_ISSUES_PER_TICK = 500` — sisanya masih di belakang watermark), dry-run, dan run yang
dibatasi `memberId`. Memajukannya di salah satu dari ketiganya melewatkan pembeli asli secara
permanen dan tidak ada apa pun di hilir yang akan menyadarinya. Konsekuensi yang disengaja:
run ber-`memberId` **tidak pernah** menulis watermark, berbeda dengan `topicDigest` yang
memang membakar watermark per-member miliknya sendiri.

**Konfigurasi setengah jadi = tidak menerbitkan apa pun** (`skipped: 'misconfigured'`), bukan
memakai nilai sebagian. `maxAmount` satu-satunya yang boleh kosong (= tanpa cap); string
non-numerik di situ ditolak, tidak dibaca sebagai "tanpa cap".

**Kandidat diurut dari yang terlama.** Kalau satu tick kena cap, yang terbit lebih dulu adalah
yang beli lebih dulu.

### 14.3 Belum dikerjakan / prasyarat

- **bb-comms belum punya jenis pesan `FirstPurchaseVoucher`.** Baris outbox sudah ditulis
  begitu program dinyalakan, dan jenis yang tidak dikenal masuk DLQ. Urutan rilis OPS-01
  mengikat: COMMS-01 naik lebih dulu.
- **Repair enrollment legacy (§13.8) belum dijalankan.** Prasyarat sebelum program dinyalakan,
  bukan sebelum kode ini di-deploy.
- Backoffice (BO-01…BO-04) belum ada, jadi hari ini satu-satunya cara menyalakan program
  adalah `UPDATE app_settings` manual — dan `launchAt` belum punya penjaga "tidak bisa
  dimundurkan", karena penjaga itu memang ada di UI. Cap 500 per tick adalah backstop-nya.
- Tidak ada job prune untuk voucher yang kedaluwarsa tanpa dipakai.

---

## 15. Status implementasi bb-comms + backoffice (15 Sep 2026)

Ketiga repo sudah dikerjakan. Branch `feat/first-purchase-voucher` di masing-masing,
belum ada yang di-commit atau di-push.

### 15.1 bb-comms — `[COMMS]`

| | |
|---|---|
| Jenis pesan | `FirstPurchaseVoucher` terdaftar di `internal/handler/handler.go` (registry jadi 13 tipe) |
| Handler | `internal/handler/first_purchase_voucher.go` — satu handler, dua kanal |
| Query | `db.GetFirstPurchaseVoucher` — `vouchers` ⋈ `members` lewat `owner_member_id`, INNER join |
| Template | `internal/render/templates/first_purchase_voucher.html` + entri di `cmd/preview` |
| WhatsApp | `SendOTP` digeneralisasi jadi `SendTemplate`; env `QONTAK_FIRST_PURCHASE_VOUCHER_TEMPLATE_ID` |
| Test | `first_purchase_voucher_test.go` — label diskon, E.164, CTA, render dua varian |

Yang perlu diingat dari implementasinya:

**Kanal tidak diturunkan ulang di sini.** Produsen sudah memutuskan email atau WhatsApp dan
mencatatnya di `vouchers.sent_channel`; handler membaca `msg.Channel`. Kalau handler
menurunkannya sendiri, laporan backoffice dan pesan yang benar-benar terkirim bisa berbeda,
dan tidak ada yang akan menyadarinya.

**Template WhatsApp belum ada = dilewati, bukan DLQ.** Tanpa env template id, `SendTemplate`
mengembalikan `dev-noop-no-template` dan mencatat log. Alasannya: template kategori MARKETING
butuh review Meta berhari-hari, vouchernya sendiri sudah tersimpan dan bisa dikirim ulang dari
backoffice, sedangkan ribuan pesan di DLQ justru mengubur kegagalan yang sungguhan. Urutan
pengecekan penting — "tidak ada kredensial sama sekali" dijawab lebih dulu daripada "template
ini tidak punya id", supaya dev tanpa kunci Qontak tetap dapat `dev-noop` seperti sebelumnya.

**Dial code ikut nomornya.** `members.phone` menyimpan bagian nasional saja; helper `e164`
menempelkan `members.phone_code` dan hanya jatuh ke `+62` kalau barisnya memang tidak punya
kode. Tanpa itu setiap member non-Indonesia dikirimi ke nomor Indonesia.

**Tombol URL WhatsApp cuma `products`.** Deep link login-prefilled yang dipakai email membawa
query string, dan tombol Qontak menerima SUFFIX path, bukan URL utuh.

**`render.idr` jadi `render.IDR`.** Pesan WhatsApp teks polos tanpa template engine, dan
salinan kedua formatter rupiah adalah cara email dan WhatsApp mulai menyebut satu voucher
dengan angka berbeda.

### 15.2 backoffice-bb — `[BO]`

| | |
|---|---|
| BO-01 | `campaign IS NULL` di `listVoucherOptions` + `getVouchers` (`lib/voucher-queries.ts`) |
| Permission | `firstPurchaseVoucher.view` / `.manage` di `lib/permissions.ts` |
| Query | `lib/first-purchase-voucher-queries.ts` — settings, ringkasan, daftar, kirim ulang |
| API | `app/api/first-purchase-voucher/{settings,resend}/route.ts` |
| Halaman | `app/(dashboard)/marketing/first-purchase-voucher/page.tsx` + dua komponen |
| Nav | sidebar grup Marketing & CRM + command palette |
| Docs | `docs/API.md` — catatan filter `campaign IS NULL` di `vouchers.list` |

**`launchAt` tidak punya input.** Nilainya distempel server saat saklar pertama kali dinyalakan
dan tidak pernah disentuh lagi, termasuk kalau program dimatikan lalu dinyalakan ulang. Tanggal
di masa lalu = job memindai seluruh riwayat dan mengirim email ke ribuan pembeli lama sekaligus,
dan itu satu-satunya tindakan di fitur ini yang tidak bisa ditarik kembali. Form menampilkan
peringatan eksplisit sebelum penyalaan pertama.

**Saklar terkunci di dua tempat**, UI dan API. Kalau hanya UI, saklar bisa dinyalakan lewat
request langsung dan halaman akan menulis "Aktif" sementara job menolak menerbitkan apa pun —
jawaban terburuk dari dua-duanya.

**Kirim ulang tidak membuat voucher.** Satu baris outbox baru dengan `refId` yang sama; bb-comms
membaca kode, nilai, dan masa berlakunya dari `vouchers`, jadi isinya selalu identik dengan yang
akan ditebus member. `id` diisi sendiri karena kolomnya UUID NOT NULL tanpa default di
database — `@default(uuid(7))` milik Prisma dihasilkan di sisi klien, bukan Postgres.

**Kartu "dilewati tanpa kontak" tidak dibuat.** Angkanya cuma ada di log backend
(`first_purchase_voucher.skipped_no_contact`); tidak ada tabel stats job di skema ini, dan
membuat satu tabel demi satu angka tidak sepadan. Catatan kaki halaman menyebutkan ini.

**Langkah ops:** `pnpm db:setup` harus dijalankan supaya role Administrator mendapat dua
permission baru — tanpa itu menunya tidak muncul untuk siapa pun.

### 15.3 Verifikasi

- bb-comms: `go build ./...`, `go vet ./...`, `go test ./internal/...` hijau.
  Satu regresi yang saya buat sendiri (urutan cek template-id vs `configured()` memecahkan
  `TestOTPWhatsApp`) ditemukan dan diperbaiki sebelum selesai.
- backoffice-bb: `npx tsc --noEmit` bersih untuk kode aplikasi; `next build` melaporkan
  "Compiled successfully" lalu berhenti di 11 error `infra/cdk` yang **pra-eksisting**
  (`aws-cdk-lib` tidak terpasang) — jumlah errornya identik pada working tree bersih.
  ESLint belum dikonfigurasi di repo itu (`next lint` membuka prompt interaktif), jadi
  gerbangnya typecheck.

### 15.4 Sisa

- **MP-01** (halaman lupa password web di marketplace) belum dikerjakan — repo marketplace tidak
  ada di mesin ini. Tanpa itu, pembeli Tribelio yang lupa password dan bukan pengguna Google
  buntu di web; email tetap terkirim dan CTA-nya tetap jalan untuk yang ingat passwordnya.
- **OPS-03** template WhatsApp ke Meta lewat Qontak — jalur terpanjang, belum diajukan.
