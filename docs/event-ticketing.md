# PRD — Penjualan Tiket Event di Marketplace

> Menjelaskan fitur penjualan tiket event: event + jenis tiket di backend, checkout tiket (multi-tiket, guest checkout) di marketplace, pengelolaan event dan peserta di backoffice, email tiket per peserta lewat bb-comms, dan pelacakan sumber pembelian lewat tracking link yang sudah ada.
> Status: DRAFT — hasil diskusi produk 8 Sep 2026, belum ada task Jira. Backlog: project **BB**, prefix `[BE]` / `[MP]` / `[BO]` / `[COMMS]`, label `event-ticket`.
> Dokumen terkait: `docs/commerce-port.md` (checkout + Xendit + voucher bypass), `docs/shop-tracking-contract.md` (atribusi UTM), `docs/register-verification-flow.md` (akun placeholder), CLAUDE.md §5.

---

## 0. Ringkasan satu paragraf

Sebuah **event** (webinar, workshop, kopdar) dijual di marketplace sebagai satu atau lebih **jenis tiket** (online, offline, early bird), masing-masing dengan harga dan kuota sendiri. Pembeli memilih jenis tiket, jumlah, mengisi **nama + email per tiket**, membayar lewat checkout yang sudah ada, dan setiap tiket dikirim sebagai **email terpisah dengan kode unik**. Pembeli **tidak perlu login** (seperti Loket), tetapi di belakang layar setiap order tetap menempel pada sebuah akun, sehingga nanti pembeli bisa mengklaim rekaman atau riwayat tiketnya cukup dengan verifikasi email. Sumber pembelian ("beli dari link Instagram X") memakai **tracking link yang sudah rilis**, bukan mekanisme baru. Yang benar-benar baru: tiga tabel (`events`, `event_ticket_types`, `event_tickets`), satu halaman checkout tiket, dua halaman backoffice, dan satu template email.

---

## 1. Keputusan produk (hasil diskusi 8 Sep)

| # | Keputusan | Konsekuensi desain |
|---|---|---|
| P1 | Lokasi event **opsional** | `events.location` nullable; event online tidak perlu alamat |
| P2 | Pembeli **tidak wajib login** | Guest checkout membuat/memakai **akun placeholder** dari email pembayar (§4.2). Kalau sudah login, pakai akun itu |
| P3 | Satu order boleh **banyak tiket** | `commerce_transactions.qty` = jumlah tiket; N baris `event_tickets` di bawah satu order |
| P4 | Komisi affiliate untuk tiket **dipisah dari skema Brainboost**, rencananya **nominal tetap**. Masih rencana, hanya disiapkan | Produk tiket **tidak** punya program affiliate saat rilis → tidak ada komisi. Ruang untuk skema tetap dicadangkan di level program (§4.4), tidak dibangun sekarang |
| P5 | Email yang sama boleh dipakai lebih dari satu tiket | Tidak ada unique `(ticket_type, email)`. Tiap tiket tetap kode unik + email sendiri |
| P6 | Satu event bisa punya **beberapa jenis tiket** dengan **kuota terpisah** | Entitas `event_ticket_types`; kuota dan masa jual per jenis |
| P7 | **Satu order = satu jenis tiket** (fase 1) | Beli online + offline sekaligus = dua pembayaran. Keranjang campuran = out of scope |
| P8 | Belum ada check-in venue | Tidak ada QR/scan di fase 1. Kode tiket dibuat supaya QR bisa ditambahkan nanti tanpa migrasi |
| P9 | Akses rekaman setelah event **mungkin perlu**; yang boleh klaim = yang ada di database pembeli | `event_tickets.email` + `member_id` (diisi saat klaim). Klaim = verifikasi email OTP (§6) |
| P10 | Refund **tidak dipikirkan** fase 1; finance manual | Tidak ada alur refund Xendit. Backoffice hanya bisa menandai tiket `VOID` |
| P11 | Data per tiket: **nama + email** | Nomor HP hanya dari pembayar |
| P12 | **Tidak ada pembayaran offline** | Semua lewat Xendit; backoffice tidak bisa menerbitkan tiket manual |
| P13 | **Tiket gratis mungkin ada** | Jenis tiket harga 0 diselesaikan lewat jalur `amount = 0` yang sudah ada (voucher bypass), tanpa Xendit |
| P14 | Tidak ada halaman daftar event; event tampil sebagai **swiper** di marketplace karena tidak selalu ada | Endpoint publik "event yang sedang dijual" untuk swiper + halaman per event; tanpa halaman indeks |
| P15 | Email tiket **template baru** di bb-comms | Jenis pesan baru → **bb-comms deploy lebih dulu** (jenis pesan tak dikenal masuk DLQ) |

---

## 2. Alur pembeli, ujung ke ujung

```
Instagram X  ──klik──▶  s.brainboost.id/webinar-sep   (shortlink → tracking link, sudah ada)
                              │ redirect + cookie bb_attr (utm_source=instagram, utm_campaign=…)
                              ▼
              shop.brainboost.id/event/<slug>           (halaman event: swiper/landing)
                              │ pilih jenis tiket (Online / Offline) + jumlah
                              ▼
              /event/<slug>/checkout
                 ┌─ pembayar: nama, email, no HP  (atau otomatis dari akun kalau login)
                 ├─ tiket #1: nama, email
                 ├─ tiket #2: nama, email   (boleh sama dengan #1)
                 └─ voucher (opsional)
                              │ POST /api/shop/events/checkout
                              ▼
   backend: buat/pakai member placeholder ─▶ tahan kuota ─▶ commerce_transactions (qty=N, utm dari cookie)
            ─▶ event_tickets × N (status RESERVED) ─▶ Xendit invoice  (atau selesai langsung jika amount = 0)
                              │
                     bayar di Xendit
                              │ webhook commerce.payment.success
                              ▼
   event_tickets → ISSUED, kode final ─▶ bb-comms: 1 email per tiket + 1 email ringkasan ke pembayar
                              │
                     backoffice: peserta muncul di /events/<id>/tickets; Sumber Traffic mencatat order pada "instagram / webinar-sep"
```

Yang **tidak** berubah: Xendit, voucher, snapshot UTM, laporan Sumber Traffic, register web, OTP. Semua dipakai apa adanya.

---

## 3. Kondisi sekarang yang dipakai ulang

| Sudah ada | Dipakai untuk |
|---|---|
| `CheckoutService.start()` + Xendit + `completeVoucherBypass()` (`amount = 0`) | Pembayaran tiket, termasuk tiket gratis |
| `commerce_transactions.qty` (selalu 1 sampai sekarang) | Jumlah tiket per order |
| `commerce_transactions.utm_*` + `guest_id`, `shop_visits`, claim | Atribusi "beli dari link Instagram X" |
| `tracking_links` + shortlink `/s/:slug` + halaman Marketing backoffice | Tim membuat link per kanal; tiket cukup **muncul di dropdown produk** |
| Akun placeholder (`isReusableUnverifiedMember`) + `/auth/requestVerificationEmail` + `/auth/validateOtpEmail` | Guest checkout + klaim akun belakangan |
| `vouchers` + `voucher_products` | Diskon tiket (produk tiket masuk whitelist seperti produk lain) |
| bb-comms (SQS `comms.*`) | Email tiket, template baru |
| `Product` (`type` string bebas) | Setiap jenis tiket = satu `Product` `type='event_ticket'` supaya checkout/voucher/tracking tidak perlu tahu apa itu tiket |

---

## 4. Keputusan desain

### 4.1 Jenis tiket = Product

Setiap `event_ticket_types` punya `product_id` (1:1) ke baris `products` dengan `type='event_ticket'`, `price` = harga tiket, `title` = "<nama event> — <nama jenis>". Alasan: checkout, voucher whitelist, tracking link, laporan Sumber Traffic, dan komisi (kalau nanti ada) semuanya berkunci pada `product_id`. Tanpa ini, setiap lapisan itu harus diajari entitas baru. Harga **dibaca dari product**, bukan disalin ke ticket type, supaya satu sumber kebenaran.

Konsekuensi P7: satu order menunjuk satu `product_id` = satu jenis tiket. Ini batasan schema `commerce_transactions` yang sudah ada (satu `product_id` per order), diterima untuk fase 1.

### 4.2 Guest checkout lewat akun placeholder

Saat submit tanpa login, backend:

1. Normalisasi email + HP pembayar (util yang sudah ada).
2. Cari member by email. Kalau ada dan **aktif** → order menempel di sana, **tanpa** login (pembeli tidak melihat apa pun; ini pembelian, bukan akses akun). Kalau ada dan placeholder → pakai ulang. Kalau tidak ada → buat placeholder (`isActive=false`, `isEmailVerified=false`, `passwordAlgo='social'`, `fullName` dari form).
3. `commerce_transactions.member_id` = member itu. Kolom tetap NOT NULL, tidak ada order yatim.

Alasan memakai placeholder, bukan `member_id` nullable: semua listener `commerce.payment.success` (enrollment, notifikasi, voucher redeem, komisi) berasumsi order punya member; melonggarkan itu menyentuh setiap listener. Placeholder juga yang membuat P9 (klaim rekaman) gratis: verifikasi email = akun aktif = riwayat tiket kelihatan.

Risiko yang diterima: seseorang bisa memakai email orang lain saat membeli. Dampaknya tiket terkirim ke email itu (pemilik email untung, bukan rugi), dan akun placeholder tidak memberi akses apa pun tanpa OTP. Sama dengan risiko register yang sudah ada.

Pembeli yang **sudah login**: form pembayar terisi otomatis, `member_id` = akun login. Tidak ada percabangan lain.

### 4.3 Kuota ditahan saat checkout, bukan saat bayar

`event_ticket_types.quota` (nullable = tak terbatas) vs jumlah `event_tickets` berstatus `RESERVED` atau `ISSUED`. Reservasi dibuat **dalam transaksi yang sama** dengan `commerce_transactions`, dengan `SELECT … FOR UPDATE` pada baris ticket type supaya dua checkout terakhir tidak sama-sama lolos. Reservasi **kedaluwarsa bersama order-nya**: cron `expire` yang sudah ada mengubah order → `EXPIRED`, listener baru mengubah tiket `RESERVED` → `EXPIRED` dan kursi kembali. Tidak ada timer terpisah.

Tiket gratis (P13): tidak ada jendela bayar, `RESERVED` → `ISSUED` seketika dalam transaksi yang sama.

### 4.4 Affiliate: dipisah, disiapkan, belum dibangun (P4)

Saat rilis: produk tiket **tidak** punya `affiliate_programs` → resolver komisi tidak menemukan program → tidak ada komisi, tidak ada perubahan kode. Tracking link tetap mencatat siapa yang membawa pembeli, jadi datanya tidak hilang.

Yang dicadangkan untuk skema "fixed" nanti, **tanpa migrasi sekarang**: komisi sudah bergantung pada `affiliate_programs` per produk. Skema tetap = kolom baru di program (`commission_mode = 'PERCENT' | 'FIXED'`, `fixed_amount`) + satu cabang di `computeAmount`, tanpa tier PERFORMANCE/GROWTH. Identitas affiliator (member + kode) **tetap sama**; yang terpisah hanya rumusnya. Menyiapkan sekarang berarti hanya: jangan menulis apa pun yang mengasumsikan semua program persen. Sudah begitu.

Kalau "terpisah" nanti berarti **affiliator berbeda** (promotor event, KOL yang bukan member), itu produk lain dan butuh PRD sendiri.

### 4.5 Kode tiket

Format `BBT-<6 alfanumerik>` (alfabet `[A-Z2-9]`, tanpa 0/O/1/I), unique global. Dibuat saat `RESERVED` supaya tampil di halaman "menunggu pembayaran", **sah hanya** saat `ISSUED`. Cukup untuk QR nanti (isi QR = kode) tanpa migrasi.

### 4.6 Email: satu per tiket + satu ringkasan

Setiap tiket → satu email ke `event_tickets.email` (nama peserta, event, jenis, tanggal, lokasi bila ada, kode). Pembayar → satu email ringkasan (N tiket, siapa saja, total). Kalau pembayar membeli untuk dirinya sendiri, dia menerima dua email (tiket + ringkasan); itu disengaja, karena email tiket adalah yang akan diteruskan atau ditunjukkan.

Dikirim dari listener `commerce.payment.success` di backend **setelah** tiket `ISSUED`, satu pesan SQS per email. Idempoten lewat `dedupeKey = ticket:<ticket_id>`, sehingga redelivery webhook tidak menggandakan email. Tanggal diformat **WIB** (presedennya trial voucher).

### 4.7 Terbuka (butuh keputusan sebelum BE-01)

| # | Pertanyaan | Default kalau tidak dijawab |
|---|---|---|
| D-1 | Voucher boleh dipakai untuk tiket? | **Ya**, lewat whitelist `voucher_products` seperti produk lain |
| D-2 | Batas jumlah tiket per order? | **10** |
| D-3 | Setelah event lewat, halaman event tetap bisa dibuka? | **Ya**, read-only dengan label "Event telah berlangsung", tombol beli hilang |
| D-4 | Nama pembayar dan nama tiket #1 otomatis sama? | **Prefill**, boleh diubah |
| D-5 | Swiper di marketplace tampil di halaman mana? | **Beranda shop**, di atas katalog, hanya jika ada event `ON_SALE` |

---

## 5. Data model (baru)

```prisma
model Event {
  id          String   @id @default(uuid(7)) @db.Uuid
  slug        String   @unique                 // URL halaman event
  title       String
  description String?                          // HTML editor backoffice
  coverUrl    String?  @map("cover_url")
  startsAt    DateTime @map("starts_at")       // UTC, tampil WIB
  endsAt      DateTime? @map("ends_at")
  location    String?                          // P1: opsional (event online)
  locationUrl String?  @map("location_url")    // Maps / Zoom (Zoom dikirim terpisah, bukan di halaman publik)
  status      String   @default("DRAFT")       // DRAFT | ON_SALE | CLOSED | CANCELED
  createdBy   String?  @map("created_by") @db.Uuid  // bo_users, tanpa FK (presedennya tracking_links)
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  ticketTypes EventTicketType[]
  @@map("events")
}

model EventTicketType {
  id          String   @id @default(uuid(7)) @db.Uuid
  eventId     String   @map("event_id") @db.Uuid
  productId   String   @unique @map("product_id") @db.Uuid   // 1:1 products(type='event_ticket'); harga dibaca dari sana
  name        String                                          // "Online", "Offline", "Early Bird"
  kind        String                                          // ONLINE | OFFLINE (untuk ikon + filter; bukan enum DB)
  quota       Int?                                            // null = tak terbatas
  maxPerOrder Int      @default(10) @map("max_per_order")     // D-2
  saleStartsAt DateTime? @map("sale_starts_at")
  saleEndsAt   DateTime? @map("sale_ends_at")
  sortOrder   Int      @default(0) @map("sort_order")
  isActive    Boolean  @default(true) @map("is_active")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  event       Event    @relation(fields: [eventId], references: [id])
  product     Product  @relation(fields: [productId], references: [id])
  tickets     EventTicket[]
  @@index([eventId])
  @@map("event_ticket_types")
}

model EventTicket {
  id            String   @id @default(uuid(7)) @db.Uuid
  code          String   @unique                    // BBT-XXXXXX (§4.5)
  ticketTypeId  String   @map("ticket_type_id") @db.Uuid
  transactionId String   @map("transaction_id") @db.Uuid   // commerce_transactions; N tiket → 1 order
  buyerMemberId String   @map("buyer_member_id") @db.Uuid  // pembayar (placeholder atau akun login)
  attendeeName  String   @map("attendee_name")
  attendeeEmail String   @map("attendee_email")            // dinormalisasi lowercase
  memberId      String?  @map("member_id") @db.Uuid        // diisi saat peserta klaim (§6); bukan pembayar
  status        String   @default("RESERVED")              // RESERVED | ISSUED | EXPIRED | VOID
  issuedAt      DateTime? @map("issued_at")
  emailSentAt   DateTime? @map("email_sent_at")
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")
  ticketType    EventTicketType @relation(fields: [ticketTypeId], references: [id])
  @@index([transactionId])
  @@index([attendeeEmail])
  @@index([ticketTypeId, status])                          // hitung kuota
  @@map("event_tickets")
}
```

Tidak ada perubahan pada `commerce_transactions` (P3 memakai `qty` yang sudah ada), `members`, `tracking_links`, `shop_visits`. `Product` mendapat relasi balik `eventTicketType EventTicketType?`.

Migrasi: satu file `event_ticketing`, aditif murni.

---

## 6. Klaim peserta (P9, disiapkan; UI fase 2)

Peserta yang emailnya ada di `event_tickets.attendee_email` bisa mengklaim tiketnya ke akun: verifikasi email lewat OTP yang sudah ada → backend mengisi `event_tickets.member_id` untuk semua tiket `ISSUED` dengan email itu yang `member_id`-nya masih NULL. Sejak itu "tiket saya" dan (nanti) "rekaman" cukup query `member_id`. Pembayar yang membeli untuk orang lain **tidak** otomatis memiliki tiket orang itu; dia hanya pemilik order.

Fase 1 hanya menyiapkan kolom dan satu fungsi `claimTicketsByEmail(memberId, email)` yang dipanggil dari `validateOtpEmail` (tempat akun diaktifkan). Halaman "Tiket saya" dan akses rekaman = fase 2.

---

## 7. Spesifikasi endpoint (backend, `apps/mobile-api/src/modules/event/`, prefix `/event`)

> Bentuk request/response lengkap + penjelasan tiap endpoint untuk FE:
> **`docs/event-ticketing-contract.md`** (ditulis 9 Sep 2026, berbahasa Inggris).
> Tabel di bawah adalah ringkasan sisi backend; kontrak itu yang dipegang
> marketplace.

| Method | Path | Auth | Fungsi |
|---|---|---|---|
| GET | `/api/event/on-sale` | publik | Event `ON_SALE` dengan ≥1 jenis tiket aktif & dalam masa jual, untuk swiper (P14). Cover, judul, tanggal, harga termurah, sisa kuota agregat (angka, bukan "habis/tersedia") |
| GET | `/api/event/:slug` | publik | Detail event + daftar jenis tiket (harga dari product, sisa kuota, masa jual, `maxPerOrder`). Event `CLOSED`/`CANCELED`/lewat tetap 200 (D-3) dengan `canBuy=false` |
| POST | `/api/event/checkout` | opsional (`authGuard` opsional; kalau ada bearer, dipakai) | Body: `ticketTypeId`, `buyer {name,email,phone}` (diabaikan jika login), `attendees [{name,email}]` (panjang = qty), `voucherCode?`, `source?` (UTM dari cookie, kontrak sama dengan shop). Validasi: qty 1..maxPerOrder, email valid & dinormalisasi, masa jual, kuota (FOR UPDATE). Membuat member placeholder bila perlu, order (`qty`), N tiket `RESERVED`, lalu meneruskan ke `CheckoutService.start`. Respons = respons checkout yang ada (invoice URL / selesai) + `tickets[{code,attendeeEmail}]` |
| GET | `/api/event/order/:code` | publik dengan `code` order + email pembayar sebagai query | Status order + tiket, untuk halaman "menunggu pembayaran"/"berhasil" tanpa login. Tidak membocorkan apa pun selain yang sudah dikirim ke email pembayar |

Error code baru: `EVENT_NOT_ON_SALE`, `EVENT_TICKET_SOLD_OUT`, `EVENT_TICKET_QTY_INVALID`, `EVENT_ATTENDEE_INVALID`. Sisanya memakai kode checkout yang ada (`VOUCHER_INVALID`, dll).

Listener baru di `@bb/domain`:
- `commerce.payment.success` → tiket `RESERVED → ISSUED`, `issuedAt`, kirim email (§4.6). Idempoten: hanya tiket yang masih `RESERVED`.
- `commerce.transaction.expired` / canceled → tiket `RESERVED → EXPIRED`. (Cek nama event yang persis di `commerce/events.ts`; kalau expire belum memancarkan event, tambahkan di cron expire.)

---

## 8. Backoffice (`backoffice-bb`, plain SQL seperti tracking link)

| Halaman | Isi |
|---|---|
| `/events` | List event: judul, tanggal, status, jenis tiket (n), terjual/kuota, pendapatan. Tombol buat event |
| `/events/new`, `/events/[id]` | Form event (P1 lokasi opsional) + tabel jenis tiket inline: nama, kind, harga, kuota, masa jual, aktif. **Menyimpan jenis tiket = membuat/memperbarui baris `products`** (`type='event_ticket'`, `is_active`, `price`) dalam satu transaksi SQL. Harga tidak bisa diubah setelah ada tiket `ISSUED` (ubah = buat jenis baru), presedennya UTM tracking link yang immutable |
| `/events/[id]/tickets` | Peserta: kode, nama, email, jenis, status, order, dibayar kapan, sumber (utm dari order). Filter status/jenis. **Export CSV** (kolom sama + no HP pembayar). Aksi per tiket: **kirim ulang email**, **VOID** (dengan alasan, audit log). Tidak ada "terbitkan manual" (P12) |
| Marketing › Tracking Links | Tidak ada perubahan kode selain memastikan produk `type='event_ticket'` muncul di dropdown produk. Sumber Traffic otomatis menghitung order tiket |

Permission baru: `events.view`, `events.manage`. `created_by` = `bo_users.id`, tanpa FK.

Plain-SQL writer wajib mengisi `id` (uuid v7) dan `updated_at` sendiri (presedennya `tracking_links`).

---

## 9. Marketplace (`brainboost-marketplace`)

| Halaman | Isi |
|---|---|
| Beranda: **swiper event** | Dari `/api/event/on-sale`; tidak dirender kalau kosong (P14, D-5) |
| `/event/[slug]` | Cover, judul, tanggal WIB, lokasi (jika ada) + tautan peta, deskripsi, kartu per jenis tiket (harga, sisa, "habis", masa jual), pilih jumlah, tombol lanjut. `canBuy=false` → tampil tanpa tombol (D-3) |
| `/event/[slug]/checkout` | Form pembayar (prefill jika login), N blok peserta (nama, email; blok #1 prefill dari pembayar, D-4), voucher, ringkasan harga. Mengirim `source` dari cookie `bb_attr`/`bb_gid` **persis seperti checkout produk** — ini yang membuat "beli dari link Instagram X" tercatat. Submit → redirect ke Xendit, atau langsung ke halaman berhasil kalau gratis |
| `/event/order/[code]?email=` | Menunggu pembayaran / berhasil / kedaluwarsa. Menampilkan kode tiket dan ke email mana dikirim |
| i18n | Semua string ID + EN (repo sudah i18n sejak 1.2.0) |

Register web tidak disentuh: guest checkout tidak melewati register. Kalau pembeli **memilih** login, alur login yang ada.

---

## 10. bb-comms

Dua jenis pesan baru: `EventTicketIssued` (per peserta) dan `EventOrderSummary` (per pembayar). Payload membawa semua yang dirender (nama, event, jenis, tanggal WIB, lokasi, kode, tautan halaman order); bb-comms **tidak** membaca database untuk merender. Template baru sesuai P15, kirim lewat SES seperti email trial.

**Urutan rilis mengikat: bb-comms dulu**, baru backend. Jenis pesan tak dikenal langsung DLQ.

---

## 11. Task breakdown

Ukuran: S ≤ 1 hari, M 2–3 hari, L 4–5 hari.

### Backend (repo ini) — `[BE]`

| ID | Task | Acceptance | Ukuran | Tergantung |
|---|---|---|---|---|
| BE-01 | Schema + migration `events`, `event_ticket_types`, `event_tickets`; relasi `Product.eventTicketType` | Migrate bersih, `prisma migrate diff` no drift, index sesuai §5 | S | D-1..D-5 |
| BE-02 | `EventService`: `listOnSale`, `getBySlug` (sisa kuota, `canBuy`, harga dari product) | Unit test masa jual/kuota/status; event lewat tetap 200 | M | BE-01 |
| BE-03 | `EventCheckoutService.start`: validasi, member placeholder (§4.2), reservasi FOR UPDATE (§4.3), order `qty=N`, N tiket, delegasi ke `CheckoutService.start`; tiket gratis langsung `ISSUED` | Integration test: dua checkout paralel untuk kursi terakhir → satu sukses satu `EVENT_TICKET_SOLD_OUT`; guest tanpa akun → placeholder dibuat; email sama 2× → 2 tiket; gratis → `ISSUED` tanpa Xendit | L | BE-01 |
| BE-04 | Listener payment success → `ISSUED` + emit SQS `EventTicketIssued` × N + `EventOrderSummary`; listener expired/canceled → `EXPIRED` | Redelivery webhook tidak menggandakan email (dedupeKey); expire mengembalikan kuota | M | BE-03, COMMS-01 |
| BE-05 | Routes + DTO + OpenAPI: 4 endpoint §7; `authGuard` opsional untuk checkout | Smoke test rute + swagger hijau; `GET /order/:code` menolak email yang tidak cocok | M | BE-02, BE-03 |
| BE-06 | `claimTicketsByEmail` dipanggil dari `validateOtpEmail` (§6) | Verifikasi email mengisi `member_id` tiket ISSUED dengan email itu; idempoten | S | BE-01 |
| BE-07 | Kode tiket generator `BBT-` (§4.5) + retry pada unique violation | Table-driven test alfabet, panjang, retry | S | BE-01 |

### bb-comms — `[COMMS]`

| ID | Task | Acceptance | Ukuran | Tergantung |
|---|---|---|---|---|
| COMMS-01 | Jenis pesan `EventTicketIssued` + `EventOrderSummary`, template email ID, tanggal WIB | Render snapshot test; deploy **sebelum** BE-04 ke prod | M | — |

### Marketplace — `[MP]`

| ID | Task | Acceptance | Ukuran | Tergantung |
|---|---|---|---|---|
| MP-01 | Swiper event di beranda (hilang kalau kosong) | 375px tidak overflow; i18n | S | BE-05 |
| MP-02 | Halaman `/event/[slug]` | Kartu jenis tiket, sisa kuota, habis, `canBuy=false` | M | BE-05 |
| MP-03 | Halaman checkout tiket: pembayar (prefill login), N peserta, voucher, `source` dari cookie | Validasi klien = validasi server; qty > maxPerOrder ditolak; order tercatat dengan utm dari tracking link (uji manual: klik shortlink → beli → cek Sumber Traffic) | L | BE-05 |
| MP-04 | Halaman `/event/order/[code]` (menunggu/berhasil/kedaluwarsa) | Polling status sampai `PAID`; tidak bocor data tanpa email pembayar | S | BE-05 |

### Backoffice — `[BO]`

| ID | Task | Acceptance | Ukuran | Tergantung |
|---|---|---|---|---|
| BO-01 | `/events` list + form event + jenis tiket inline (menulis `products` dalam transaksi yang sama); permission `events.*`; audit log | Harga terkunci setelah ada tiket ISSUED; `id` + `updated_at` diisi writer | L | BE-01 |
| BO-02 | `/events/[id]/tickets`: peserta, filter, CSV, kirim ulang email, VOID | CSV terbaca spreadsheet (format tanggal yang sudah disepakati); VOID tercatat di audit | M | BO-01, BE-04 |
| BO-03 | Produk `type='event_ticket'` tampil di dropdown Tracking Links | Link untuk tiket bisa dibuat; Sumber Traffic menghitung order tiket | S | BE-01 |

### Ops

| ID | Task |
|---|---|
| OPS-01 | Urutan rilis: COMMS-01 → backend (migrasi + BE-*) → backoffice → marketplace. Migrasi aditif, tanpa downtime |

Jalur kritis: BE-01 → BE-03 → BE-05 → MP-03. Backend dan backoffice bisa paralel setelah BE-01; bb-comms paralel sejak awal.

---

## 12. Out of scope (fase 1)

- Keranjang campuran beberapa jenis tiket dalam satu pembayaran (P7).
- QR code, check-in venue, aplikasi scanner (P8).
- Halaman "Tiket saya" dan akses rekaman di aplikasi/marketplace (P9 hanya disiapkan, §6).
- Refund, pembatalan event dengan pengembalian dana (P10). Membatalkan event di backoffice hanya menutup penjualan.
- Pembayaran offline / terbit manual (P12).
- Transfer tiket antar email setelah terbit.
- Skema komisi affiliate nominal tetap (P4, §4.4).
- Harga bertingkat otomatis berdasarkan waktu (early bird cukup dibuat sebagai jenis tiket terpisah dengan `sale_ends_at`).
- Pengingat H-1 via email/WA.

---

## 13. Risiko

| Risiko | Mitigasi |
|---|---|
| Kursi ganda saat dua orang membeli kursi terakhir bersamaan | Reservasi dalam transaksi + `FOR UPDATE` pada ticket type (BE-03), diuji paralel |
| Kuota "hilang" karena order menggantung tak dibayar | Reservasi kedaluwarsa bersama order lewat cron expire yang ada; sisa kuota dihitung dari status, bukan counter |
| Email tiket ganda karena webhook Xendit dikirim ulang | `dedupeKey` per tiket di outbox comms |
| Salah ketik email peserta → tiket nyasar | Typo-guard email yang sudah ada di register web dipakai ulang di form peserta (saran, bukan tolak); pembayar selalu dapat ringkasan berisi semua kode, jadi tiket tetap bisa ditunjukkan |
| bb-comms belum deploy saat backend naik | OPS-01; jenis pesan tak dikenal masuk DLQ dan bisa di-replay setelah bb-comms naik, tidak hilang |
| Harga jenis tiket diubah setelah terjual → laporan tidak konsisten | Harga terkunci setelah ada tiket ISSUED (BO-01) |
| Placeholder member menumpuk dari pembeli tamu | Sama dengan placeholder register; tidak diakses siapa pun tanpa OTP; bisa di-prune bersama placeholder lain kalau nanti dibuat |

---

## 14. Revisi hasil verifikasi kode (9 Sep 2026)

Bagian 0–13 di atas adalah PRD produk apa adanya. Bagian ini adalah hasil
pengecekan setiap asumsi teknisnya terhadap kode yang benar-benar ada di repo.
**Kalau bagian ini bertentangan dengan bagian di atas, bagian ini yang benar.**

### 14.1 Asumsi yang terbukti benar

| Klaim PRD | Bukti di kode |
|---|---|
| `commerce_transactions.qty` sudah ada | `prisma/schema.prisma:1129` — `@default(1)`, komentar "reserved; always 1 for course MVP" |
| Jalur `amount = 0` tanpa Xendit | `packages/domain/src/commerce/payment.service.ts:56` → `completeVoucherBypass()`, yang tetap memancarkan `commerce.payment.success` |
| `isReusableUnverifiedMember` | `packages/common/src/utils/member-state.util.ts:25` |
| `validateOtpEmail` = titik aktivasi akun | `apps/mobile-api/src/modules/auth/auth.service.ts:1350-1358` |
| `Product.type` string bebas, `voucher_products` ada | `prisma/schema.prisma:383`, `:404` |
| Snapshot UTM di order, ditulis sekali | `packages/domain/src/commerce/checkout.service.ts:25` (`TrackingSource`) + `create` |
| Shortlink `/s/:slug` **sudah rilis** | `apps/mobile-api/src/shortlink.ts` + `tracking_links` + `tracking_link_clicks`. CLAUDE.md §5 masih menulis "no shortlink redirect exists" — itu **basi**, perbaiki saat menyentuh §5 berikutnya |
| Produk non-course tidak salah dapat enrollment | `packages/domain/src/commerce/listeners/payment-success.listener.ts:88` — `if (!product?.course) return`. Produk `event_ticket` no-op, aman |
| `computeTotals` sudah menerima `qty` | `packages/domain/src/commerce/utils/compute-totals.ts:33` — `qty` opsional, `itemTotal = unitPrice * qty` |

### 14.2 Koreksi yang memblokir (wajib beres sebelum/di dalam BE-03)

**R-1 — `CheckoutService.start` mengunci `qty: 1`.**
`checkout.service.ts:88` (`computeTotals({ qty: 1 })`) dan `:107` (`qty: 1` pada
`create`). §3 menulis checkout "dipakai apa adanya" — tidak bisa. `qty` harus
ditambahkan ke `StartCheckoutInput` dan diteruskan ke dua tempat itu.
Perubahannya kecil karena `computeTotals` sudah siap (14.1), tapi ini perubahan
kode di jalur pembayaran utama, bukan pemakaian ulang. Tanpa ini, order 3 tiket
ditagih harga 1 tiket.

**R-2 — Cron expire menyapu PAYMENT, bukan TRANSACTION → kuota bocor permanen.**
`packages/domain/src/jobs/expire-pending-payments.ts:10` hanya membaca
`commerce_payments` berstatus `PENDING`. Checkout dua langkah: kalau pembeli
berhenti **setelah checkout tapi sebelum baris payment dibuat** (tutup tab di
halaman pilih metode bayar — kasus paling umum), tidak pernah ada baris payment,
sehingga transaksinya tinggal `PENDING` selamanya. Konsekuensinya tiket
`RESERVED` tidak pernah jadi `EXPIRED` dan **kursinya hilang untuk selamanya**.
Klaim §4.3 ("reservasi kedaluwarsa bersama order lewat cron expire yang sudah
ada") hanya benar untuk order yang sempat membuat payment.

Dua pilihan, pilih satu sebelum BE-01:

- **(a) Kuota tidak butuh job sama sekali.** Hitung kursi terpakai sebagai
  `ISSUED` + (`RESERVED` yang order-nya belum lewat `expiredAt`). Reservasi
  kedaluwarsa dengan sendirinya lewat waktu, presedennya persis predikat
  `activeEnrollment()` pada trial voucher (CLAUDE.md §5) yang juga memilih
  predikat berbasis tanggal ketimbang cron. Baris tiket boleh dirapikan
  belakangan tanpa mempengaruhi angka kuota.
- **(b) Sweeper baru** `expirePendingTransactions`: transaksi `PENDING` yang
  `expiredAt < now` dan tidak punya payment aktif → `EXPIRED`, lalu tiket ikut
  `EXPIRED`.

Rekomendasi **(a)**: angka kuota tidak pernah bergantung pada job yang mungkin
mati, dan itu alasan yang sama kenapa PRD memilih menghitung baris ketimbang
counter. Kalau (b) dipilih, ia masuk jalur kritis dan harus rilis bersama BE-03.

**R-3 — Event `commerce.transaction.expired` tidak ada.**
`packages/common/src/events/commerce-events.ts` hanya punya
`commerce.payment.success | refunded | expired | failed`; yang expired
bermuatan `{ paymentId, transactionId }`. Pertanyaan terbuka di §7 terjawab:
pakai `commerce.payment.expired` untuk order yang sempat punya payment, dan
tutup sisanya lewat R-2.

**R-4 — Pembeli tiket akan menerima email resi KURSUS.**
`packages/domain/src/comms/listeners/commerce-email.listener.ts:30` mengirim
`CoursePaymentSuccess` pada **setiap** `commerce.payment.success`, dan listener
kedua (`:47`) mengirim `SaleAlert` ke tim. bb-comms merender resi itu dari
`commerce_transactions`, jadi pembeli tiket akan menerima resi berjudul kursus —
total tiga email (tiket + ringkasan + resi kursus). Harus ada cabang
`type = 'event_ticket'` yang melewati keduanya, persis pola `isTrial` di baris
28 (preseden: trial mengganti tipe pesan dan melewati `SaleAlert`). Masuk BE-04.
Keputusan produk yang perlu ditegaskan: apakah penjualan tiket layak memicu
`SaleAlert`? Default di sini **tidak** — email ringkasan pembayar sudah menjadi
jejaknya, dan alert per tiket akan membanjiri inbox saat webinar ramai.

**R-5 — Guest tidak bisa melewati langkah bayar yang ada.**
`payment.service.ts:43` — `PaymentService.create(memberId, dto)` dipanggil dari
route ber-`authGuard` dan menolak dengan `TRANSACTION_NOT_OWNED` kalau
`tx.memberId` bukan pemanggil. Pembeli tamu tidak punya bearer, jadi ia tidak
akan pernah sampai ke invoice Xendit. Maka `POST /api/event/checkout` **harus
menjalankan kedua langkah di server**: `CheckoutService.start` lalu
`PaymentService.create` dengan memberId placeholder, dan mengembalikan
`invoiceUrl` (atau hasil bypass untuk tiket gratis) dalam satu respons. §7 sudah
menyiratkannya lewat "respons checkout yang ada (invoice URL / selesai)", tapi
tidak menyatakannya sebagai keharusan — nyatakan, kalau tidak FE buntu di
tengah alur.

Konsekuensi lanjutan: tiket gratis **tidak** perlu perlakuan khusus. Panggil
`PaymentService.create` seperti biasa, `amount = 0` masuk ke
`completeVoucherBypass`, event `commerce.payment.success` terpancar, dan
listener BE-04 yang menerbitkan tiket. Satu jalur penerbitan tiket, bukan dua.
Ini menggantikan kalimat §4.3 "`RESERVED` → `ISSUED` seketika dalam transaksi
yang sama".

**R-6 — Shortlink mendarat di halaman produk, bukan halaman event.**
`packages/domain/src/shop/tracking-link.service.ts:100` membangun
`${base}/product/${ref}?utm...` — path-nya hardcoded. Alur §2 (klik
`s.brainboost.id/webinar-sep` → halaman event) tidak jalan; pengunjung mendarat
di halaman produk shop. Klaim BO-03 "tidak ada perubahan kode selain dropdown"
karena itu salah. Perlu satu cabang di `resolve()`: kalau produk tujuan
bertipe `event_ticket`, arahkan ke `/event/<event.slug>`. Task backend baru
(BE-09 di 14.5).

### 14.3 Koreksi tingkat menengah

**R-7 — Voucher `TRIAL` bisa nyasar ke tiket.** `computeTotals` memberi potongan
100% untuk tipe `TRIAL` (`compute-totals.ts:38`), lalu listener memanggil
`grantCourseEnrollment` yang no-op untuk produk tiket. Hasilnya tiket gratis
tanpa jejak trial dan tanpa error. Bukan bug hari ini (produk tiket tidak akan
di-whitelist ke voucher trial), tapi satu salah klik ops sudah cukup. Tolak
`type = 'TRIAL'` secara eksplisit di validasi checkout event.

**R-8 — Notifikasi in-app tetap ditulis untuk pembeli tamu.**
`packages/domain/src/notification/listeners/commerce.listener.ts:11` menulis
baris notifikasi `paymentSuccess` untuk setiap pembayaran, termasuk ke member
placeholder yang tidak pernah membuka aplikasi. Push-nya sendiri tidak terkirim
(tidak ada device token), jadi ini sampah baris, bukan kesalahan yang terlihat
pembeli. Lewati untuk `event_ticket` bersamaan dengan R-4.

**R-9 — Refund tidak disinggung padahal event-nya hidup.** `commerce.payment.refunded`
sudah ada dan sudah dipakai (`commerce-email.listener.ts:79`). P10 menyatakan
refund di luar cakupan, tapi refund yang dilakukan finance lewat dashboard
Xendit tetap memancarkan event itu, dan tiketnya akan tetap `ISSUED`. Minimal:
tulis perilaku ini sebagai diketahui-dan-diterima. Lebih baik: satu listener
`refunded` → tiket `VOID`, murah dan menutup celah "tiket sudah dikembalikan
dananya tapi masih sah".

**R-10 — Klaim tiket via `validateOtpEmail` hanya menangkap sebagian orang.**
§6 menempelkan `claimTicketsByEmail` pada `validateOtpEmail`, padahal member
yang mendaftar lewat Google atau lewat nomor HP tidak pernah melewati fungsi
itu — tiket mereka tidak akan pernah terklaim. Lebih sederhana: **hapus BE-06
dan kolom `event_tickets.member_id`**. Query "tiket saya" cukup
`attendeeEmail = member.email AND member.isEmailVerified = true`; kepemilikan
adalah fakta yang bisa dihitung, bukan yang perlu disimpan. Kalau kolomnya tetap
ingin dipertahankan untuk fase 2, biarkan nullable dan jangan ada yang
membacanya di fase 1.

**R-11 — Cara mengunci kuota.** PRD memilih `SELECT … FOR UPDATE` + hitung baris;
preseden di repo justru update atomik berpenghitung (`UPDATE vouchers SET used =
used + 1 … WHERE` kuota masih muat). Hitung-baris tetap pilihan yang lebih baik
di sini karena tidak ada counter yang bisa melenceng saat reservasi kedaluwarsa
— tapi ia menuntut `$queryRaw` (sah menurut CLAUDE.md §4: pengecualian untuk
hal yang memang butuh SQL). Tulis alasan itu di kode, kalau tidak reviewer
berikutnya akan menggantinya dengan counter. Dengan R-2(a), predikat kuotanya
menjadi: `ISSUED` + `RESERVED` yang order-nya belum kedaluwarsa.

**R-12 — `event_tickets` sebaiknya PUNYA foreign key.** §5 menulis
`transaction_id` dan `buyer_member_id` sebagai skalar tanpa relasi, mengutip
preseden `AffiliateVisit` / `ShopVisit` / `TrackingLink`. Preseden itu tidak
berlaku: ketiganya ditulis oleh endpoint publik yang tidak boleh gagal, atau
menunjuk tabel milik backoffice. `event_tickets` ditulis oleh service kita
sendiri di dalam satu transaksi dengan order-nya, jadi FK ke
`commerce_transactions` dan `members` aman dan memberi integritas gratis.
Pakai FK.

**R-13 — Satu tracking link hanya bisa menunjuk satu jenis tiket.**
`tracking_links.product_id` NOT NULL dan `UNIQUE (utm_source, utm_campaign)`
(`prisma/schema.prisma:1498`, `:1506`). Untuk event dengan dua jenis tiket, satu
link hanya bisa membawa salah satunya. Dengan R-6 (redirect ke halaman event)
hal ini tidak terasa oleh pengunjung — jenis tiket yang tertulis di link
sekadar pembawa. Dokumentasikan pilihannya; jangan menambah `event_id` kecuali
laporan nanti benar-benar butuh mengelompokkan per event.

### 14.4 Yang tidak berubah

Xendit, voucher, snapshot UTM, laporan Sumber Traffic, register web, OTP,
`shop_visits` + claim, dan bentuk respons checkout — semuanya benar-benar
dipakai apa adanya. Tidak ada migrasi pada `commerce_transactions`, `members`,
`tracking_links`, `shop_visits`. Perubahan pada `CheckoutService` (R-1) murni
kode, tanpa DDL.

### 14.5 Efek ke pemecahan task (§11)

| Task | Perubahan |
|---|---|
| BE-01 | Tambah FK pada `event_tickets` (R-12). Kolom `member_id` TETAP ada (K-3). Ukuran tetap S |
| BE-03 | **Bertambah**: `qty` di `StartCheckoutInput` (R-1), panggil `PaymentService.create` di dalam service yang sama (R-5), tolak voucher TRIAL (R-7). Kuota dihitung dari `status IN (RESERVED,ISSUED)` (K-1). Tetap L, tapi lebih padat. Hapus penanganan khusus tiket gratis — ia lewat jalur bypass yang sama |
| BE-04 | **Bertambah**: lewati `CoursePaymentSuccess` + `SaleAlert` untuk produk `event_ticket` (R-4), lewati notifikasi in-app (R-8). Tetap M |
| BE-05 | **Bertambah**: rate limiter per IP + per email, respons tidak boleh membocorkan keberadaan akun, batas `qty` ditegakkan server-side (R-16). Tetap M |
| BE-06 | **Tetap dibuat** (K-3). Acceptance ditambah: tulis gap Google/HP di kode + docs, jangan diam-diam |
| **BE-08 (baru, WAJIB)** | Job `expirePendingTransactions`, **dibatasi ke produk `event_ticket`** (R-14) dan juga menyapu transaksi `CANCELED` yang masih punya tiket `RESERVED` (R-15). Daftarkan di `jobs-runner.ts`, `ecosystem.config.js`, `infra/cdk/lib/bb-ecs-stack.ts` (K-1). Ukuran S, **jalur kritis** — rilis bersama BE-03 |
| **BE-09 (baru)** | Redirect shortlink sadar-event: produk `event_ticket` → `/event/<slug>` (R-6). Ukuran S. Menggantikan asumsi BO-03 |
| **BE-10 (baru, opsional)** | Listener `commerce.payment.refunded` → tiket `VOID` (R-9). Ukuran S |
| BO-03 | Bukan lagi "tanpa perubahan kode" — bergantung pada BE-09 |
| Sisanya | BE-02, BE-07, COMMS-01, MP-01..04, BO-01, BO-02 valid apa adanya |

Jalur kritis: BE-01 → BE-03 **+ BE-08** → BE-05 → MP-03. BE-08 tidak boleh
tertinggal di belakang BE-03: begitu checkout tiket terbuka ke publik tanpa
sweeper, setiap checkout yang ditinggal mengunci kursi selamanya. BE-09 masuk
sebelum uji manual "klik shortlink → beli → cek Sumber Traffic" pada MP-03.

### 14.6 Keputusan (9 Sep 2026)

Empat pertanyaan terbuka di 14.2/14.3 sudah dijawab. Nilai di bawah ini
mengikat; kalau berbeda dengan uraian di 14.2/14.3, yang di sini yang berlaku.

**K-1 (R-2) — kuota: SWEEPER, bukan predikat waktu.**
Kursi terpakai dihitung sederhana: `event_tickets.status IN ('RESERVED','ISSUED')`
per `ticket_type_id`, memakai index `(ticket_type_id, status)` yang sudah ada di
§5. Yang mengembalikan kursi adalah job baru **BE-08 `expirePendingTransactions`**:
transaksi `PENDING` yang `expiredAt < now` dan tidak punya payment aktif →
`EXPIRED`, tiket `RESERVED` di bawahnya ikut `EXPIRED`.

Konsekuensi yang harus diperlakukan serius:
- BE-08 masuk **jalur kritis** dan wajib rilis bersama BE-03. Migrasi boleh naik
  duluan, tapi endpoint checkout tidak boleh dibuka ke publik sebelum
  sweeper-nya jalan — tanpa itu setiap checkout yang ditinggal mengunci kursi
  selamanya, dan tidak ada yang memberitahu sampai event kelihatan "habis"
  padahal kosong.
- `event_tickets.status` menjadi **load-bearing**, bukan kosmetik: angka kuota
  membacanya langsung. Setiap jalur yang mengubah status tiket harus benar.
- Daftarkan job-nya di `jobs-runner.ts` **dan** di `ecosystem.config.js` **dan**
  di `infra/cdk/lib/bb-ecs-stack.ts`. Kedua lane cron memfilter berdasarkan
  argv; nama yang tidak terdaftar tidak pernah jalan dan **tidak pernah error**
  (preseden: `streakReminder`, CLAUDE.md §5).
- Sweeper harus idempoten dan hanya menyentuh tiket yang masih `RESERVED`,
  supaya order yang sudah dibayar tepat sebelum sapu tidak ikut dibatalkan.
  Urutan aman: flip transaksi dengan `updateMany … WHERE status='PENDING'`,
  lalu tiket `WHERE status='RESERVED'`; nol baris = sudah ditangani pihak lain.

**K-2 (R-4) — `SaleAlert` DILEWATI untuk produk `event_ticket`.**
Email ringkasan ke pembayar sudah menjadi jejak penjualannya, dan satu alert per
order akan membanjiri inbox tim saat webinar ramai. Preseden: trial voucher juga
dilewati. `CoursePaymentSuccess` tetap dilewati juga (R-4) — pembeli tiket hanya
menerima email tiket + ringkasan.

**K-3 (R-10) — kolom `event_tickets.member_id` dan BE-06 TETAP dibuat**, sesuai
§6. `claimTicketsByEmail(memberId, email)` dipanggil dari `validateOtpEmail`.

Gap yang diketahui dan diterima: member yang mendaftar lewat Google/Apple
(`loginWithSocial`) atau lewat nomor HP (`validateOtpPhone`) **tidak pernah
melewati `validateOtpEmail`**, sehingga tiketnya tidak terklaim dan `member_id`
tetap NULL. Untuk mereka, fase 2 harus menyediakan jalur klaim tersendiri —
paling murah: panggil `claimTicketsByEmail` juga dari titik aktivasi lain, atau
jadikan "Tiket saya" membaca `member_id` **atau** `attendee_email` yang cocok
dengan email member terverifikasi. Jangan sampai fase 2 dimulai dengan asumsi
`member_id` selalu terisi.

**K-4 (D-1..D-5) — semua default §4.7 dipakai**, dengan catatan D-4:
prefill blok peserta #1 dari data pembayar, field tetap bisa diedit (bukan
dikunci, bukan dikosongkan). Murni perilaku FE di MP-03, tidak menyentuh
backend. D-2 maks 10 tiket per order (`event_ticket_types.max_per_order`
default 10). D-1 voucher boleh dipakai untuk tiket lewat whitelist
`voucher_products` — karena itu R-7 tetap berlaku: tolak voucher `type='TRIAL'`
untuk produk `event_ticket` secara eksplisit di checkout event.

### 14.7 Dampak ke kode yang sudah jalan, dan risiko break

Ditelusuri 9 Sep 2026, sebelum baris pertama ditulis. Ringkasnya: **10 file lama
disentuh, mayoritas satu cabang `if`**; sisanya file baru. Yang benar-benar
mengubah perilaku kode lama hanya dua listener.

| File lama | Perubahan | Risiko |
|---|---|---|
| `prisma/schema.prisma` | 3 model baru + back-relation `Product.eventTicketType?` | **Nol.** Aditif; FK ada di sisi tabel baru, tidak ada DDL di tabel lama. Rollback = drop 3 tabel |
| `packages/domain/src/commerce/checkout.service.ts:88,107` | `qty` opsional (R-1) | **Rendah.** `computeTotals` sudah menerima `qty`, default 1 → pemanggil lama identik. Tetap jalur uang: wajib ada test yang membuktikan `qty=1` tak berubah |
| `packages/domain/src/comms/listeners/commerce-email.listener.ts:30,47` | Lewati `CoursePaymentSuccess` + `SaleAlert` untuk `event_ticket` (K-2) | **Tertinggi.** Cabang yang salah membuat pembeli KURSUS kehilangan resi — dan email yang tidak terkirim tidak memancing keluhan sampai berhari-hari kemudian |
| `packages/domain/src/notification/listeners/commerce.listener.ts:11` | Lewati notifikasi untuk `event_ticket` (R-8) | **Sedang.** Kelas kesalahan sama dengan di atas |
| `packages/domain/src/shop/tracking-link.service.ts:100` | Cabang URL → `/event/<slug>` (R-6) | **Sedang.** Redirect ini melayani kampanye yang sedang berjalan. Wajib fallback ke perilaku lama untuk setiap kasus yang tidak dikenali — jangan pernah 404 |
| `apps/mobile-api/src/jobs-runner.ts` + `ecosystem.config.js` + `infra/cdk/lib/bb-ecs-stack.ts` | Daftarkan BE-08 (K-1) | **Rendah** untuk kode lama, tapi satu daftar yang terlewat = job diam tanpa error |
| `apps/mobile-api/src/modules/auth/auth.service.ts:1350` | Panggil `claimTicketsByEmail` (BE-06) | **Rendah**, tapi ini titik aktivasi akun. Bungkus try/catch: klaim tiket yang gagal tidak boleh menggagalkan verifikasi email |
| `apps/mobile-api/src/core/register-modules.ts` | Daftarkan modul event | Nol |

**R-14 — sweeper BE-08 punya jangkauan jauh lebih luas dari tiket.**
Kalau ditulis generik ("semua transaksi `PENDING` lewat `expiredAt`"), sapuan
pertama akan mengubah **seluruh checkout kursus yang pernah ditinggal sejak
commerce rilis**. Datanya sendiri tidak rusak — `payment.service.ts:52` sudah
menolak transaksi lewat `expiredAt` dengan `TRANSACTION_EXPIRED`, jadi baris itu
memang sudah mati secara fungsional — tapi `/payment/commerce/list` punya filter
status (`commerce.controller.ts:95`) dan aplikasi menampilkan daftar "menunggu
pembayaran". Seluruh backlog itu akan pindah ke `EXPIRED` sekaligus, dalam satu
tick cron, tanpa ada yang memintanya. Jumlah barisnya belum diukur.

**Keputusan: fase 1 sweeper DIBATASI ke order tiket** — join ke produk
`type='event_ticket'`. Blast radius terhadap commerce kursus menjadi nol.
Menggeneralisasi sweeper ke semua produk adalah keputusan tersendiri yang butuh
angka backlog lebih dulu, bukan efek samping fitur tiket.

**R-15 — `cancel()` tidak memancarkan event apa pun.**
`packages/domain/src/commerce/payment.service.ts:330` membalik transaksi ke
`CANCELED` tanpa `commerceEvents.emit`. Jadi pembeli yang menekan batal
meninggalkan tiketnya `RESERVED` dan kursinya terkunci sampai... tidak pernah:
sweeper R-2 hanya melihat `PENDING`. Lubang ini tidak tercatat di §4.3 maupun §7.

Perbaikannya **jangan** dengan menambah emit di `payment.service.ts` — itu jalur
pembayaran yang tidak perlu disentuh demi fitur ini. Cukup buat sweeper BE-08
juga menyapu transaksi berstatus `CANCELED` yang masih punya tiket `RESERVED`.
Satu predikat tambahan, nol perubahan di jalur uang.

**R-16 — `POST /api/event/checkout` publik adalah permukaan penyalahgunaan baru.**
Endpoint tanpa auth ini melakukan dua hal mahal: **menulis baris `members`** dan
**memanggil Xendit membuat invoice**. Belum ada preseden untuk itu di repo —
`POST /api/shop/visits` memang publik, tapi ia hanya menulis satu baris lokal.
Tanpa penjagaan, endpoint ini bisa dipakai membanjiri tabel `members` dan
menumpuk invoice di dashboard Xendit (yang berbiaya dan dilihat finance).

Wajib, bukan opsional:
- Rate limiter per IP **dan** per email pembayar. Berbeda dari
  `shopVisitRateLimiter` yang sengaja selalu 200 — di sini menolak adalah
  perilaku yang benar, karena permintaan ini berbiaya nyata.
- Respons tidak boleh membedakan "email ini sudah punya akun" dari "belum".
  Kalau berbeda, endpoint berubah menjadi alat enumerasi akun; §4.2 sudah
  menetapkan pembeli tidak melihat apa pun soal status akunnya, dan itu harus
  benar sampai ke kode error juga.
- Batas `qty` (D-2 = 10) ditegakkan di server, bukan hanya di form.

**Yang terbukti aman, tidak perlu disentuh:**
`payment-success.listener.ts:88` sudah menjaga produk non-course dari enrollment
(`if (!product?.course) return`). Komisi affiliate tidak akan jalan sendiri
tanpa `affiliate_programs` untuk produk tiket (P4). Webhook Xendit, refund,
voucher redeem, snapshot UTM, dan `shop_visits` tidak disentuh sama sekali.

**Gerbang sebelum commit:** `pnpm typecheck` + `pnpm test` hijau, ditambah satu
test baru yang membuktikan pembeli **kursus** tetap menerima
`CoursePaymentSuccess` setelah cabang tiket masuk. Itu regresi yang paling mudah
lolos tanpa ketahuan, dan spec commerce yang ada (`checkout.spec`,
`webhook.spec`, `voucher-trial.spec`, `expire-job.spec`) belum menutupnya.

### 14.8 Masih terbuka

- Apakah sweeper BE-08 nanti digeneralisasi ke semua produk (R-14)? Butuh
  hitungan backlog transaksi `PENDING` basi di prod lebih dulu. Fase 1 tetap
  dibatasi ke order tiket.
- Tidak ada lagi yang memblokir BE-01.

---

## 15. Catatan implementasi (9 Sep 2026)

Branch `feat/event-ticketing`. Yang sudah jalan dan yang ditemukan saat menulisnya.

### 15.1 Sudah dibangun

| Task | Isi |
|---|---|
| BE-01 | Migration `20260909120000_event_ticketing` + 3 model. Ditulis tangan: user DB tidak punya hak `CREATE DATABASE`, jadi shadow DB gagal dan `prisma migrate dev` tidak bisa dipakai di lingkungan ini |
| BE-02 | `EventService.listOnSale` / `getBySlug` (`apps/mobile-api/src/modules/event/event.service.ts`) |
| BE-05 (baca) | `GET /api/event/on-sale`, `GET /api/event/:slug` |
| BE-07 | `generateTicketCode()` — `packages/domain/src/event/ticket-code.ts` |
| BE-03 | `EventCheckoutService.start` + `POST /api/event/checkout` |
| BE-08 | `expireEventTicketOrders` + terdaftar di jobs-runner, `ecosystem.config.js`, CDK |
| BE-04 | `registerEventTicketListeners` — tiket `RESERVED → ISSUED` + antre `EventTicketIssued` × N + `EventOrderSummary`; plus lewati `CoursePaymentSuccess`, `SaleAlert` (R-4) dan notifikasi in-app (R-8) untuk order tiket |
| BE-05 (sisa) | `GET /api/event/order/:code?email=` |
| BE-06 | `claimTicketsByEmail` dipanggil dari `validateOtpEmail` |
| BE-09 | Redirect shortlink sadar-event: produk `event_ticket` → `/event/<slug>` |
| BE-10 | Listener `commerce.payment.refunded` → tiket `VOID` |

**Seluruh task backend di repo ini selesai.** Belum: sisi MP/BO (COMMS-01 selesai di repo bb-comms, branch `feat/event-ticket-emails`).

**Membuat event sebelum backoffice jadi:** `pnpm seed:event` (`scripts/seed-event.ts`) — satu event + tiga jenis tiket (Online berbayar, Offline berbayar, Gratis untuk menguji jalur `amount=0` tanpa Xendit). Flag: `--slug=`, `--status=`, `--quota=`, `--days=` (negatif = event yang sudah lewat), `--delete=<slug>`. Idempoten per slug: event yang sudah ada dilaporkan dan **dibiarkan**, tidak ditimpa — re-run tidak boleh diam-diam mereset baris yang sedang dipakai orang menguji. `--delete` menolak bekerja kalau sudah ada tiket terjual: baris tiket menunjuk order dan pembayaran nyata, menghapusnya meninggalkan sisi uang yang menggambarkan pembelian atas sesuatu yang tidak ada lagi. Skrip ini ada karena app memang **tidak punya endpoint pembuatan event** — event ditulis backoffice lewat SQL biasa.

**Blokir rilis: COMMS-01 belum ada.** BE-04 menulis dua jenis pesan baru ke outbox; bb-comms yang belum mengenalnya akan melempar keduanya ke DLQ. Backend ini **tidak boleh naik ke prod sebelum bb-comms**. Pesannya tidak hilang (bisa di-replay dari DLQ), tapi tiket tidak sampai ke pembeli sampai itu beres.

### 15.2 Keputusan yang diambil saat implementasi

- **"Event lewat" = `endsAt ?? startsAt` sudah lewat.** PRD hanya menulis "lewat" tanpa mendefinisikan. Konsekuensinya penjualan **masih terbuka selama event berlangsung** (orang yang telat masuk webinar tetap pembeli sah) dan tertutup begitu selesai. Kalau produk ingin penjualan berhenti saat event dimulai, itu satu baris di `hasFinished()`.
- **`/on-sale` menuntut ada jenis tiket yang benar-benar bisa dibeli**, bukan sekadar event `ON_SALE`. Event yang habis atau di luar masa jual keluar dari swiper tapi halamannya tetap 200 — kartu yang menuju halaman tanpa tombol beli adalah jalan buntu.
- **`remainingQuota` agregat jadi `null` kalau ada satu jenis tiket tak terbatas.** Menjumlahkan sebagian akan terbaca sebagai jumlah kursi, dan itu salah.
- **Kursi diklaim SESUDAH order dibuat, bukan sebelum** — baris tiket butuh `transaction_id`-nya. Celah di antara keduanya tidak bisa menjual berlebih: klaim mengambil row lock `FOR UPDATE` pada ticket type lalu menghitung di dalamnya, jadi yang kalah melihat baris pemenang dan gugur. Kalau gugur, ordernya langsung di-`CANCELED` supaya percobaan berikutnya tidak terhalang order menggantung milik pembeli itu sendiri.
- **Tiket gratis lewat jalur yang sama persis.** `PaymentService.create` dipanggil tanpa syarat; `amount = 0` masuk ke `completeVoucherBypass`. Menggantikan rencana §4.3 (`RESERVED → ISSUED` seketika) — satu jalur penerbitan tiket, bukan dua.
- **Nomor HP pembayar tamu ditulis ke `members.phone` hanya kalau nomor itu belum dipakai akun lain.** Kolom itu UNIQUE, dan tamu bisa saja mengetik nomor milik orang lain. Nomor di sini adalah kenyamanan untuk ekspor backoffice, bukan identitas, jadi ia dibuang ketimbang menggagalkan penjualan.
- **Idempotensi penerbitan tiket bersandar pada transisinya sendiri, bukan pada dedupe key.** `notification_outbox` tidak punya kolom dedupe, dan PRD §4.6 mengasumsikan ada. Tidak perlu: flip-nya `updateMany … WHERE status = 'RESERVED'`, jadi webhook Xendit yang dikirim ulang mencocokkan nol baris dan tidak mengirim apa pun. Email diantre **di dalam transaksi yang sama**, sehingga "tiket terbit" dan "email terantre" tidak pernah bisa berbeda — crash di antaranya membatalkan keduanya dan pengiriman ulang mengerjakan semuanya.
- **`email_sent_at` distempel saat pesan diserahkan ke outbox**, bukan saat SES menerimanya. Itu memang momen yang dijaga kolom ini: sesudahnya pesan tidak boleh diantre lagi.
- **`GET /order/:code` menyamakan SEMUA kegagalan menjadi 404** — kode tidak dikenal, email salah, dan order yang tidak memuat tiket. 403 untuk "kode benar, email salah" justru memberi tahu penebak bahwa kodenya ada.
- **Klaim tiket dipasang HANYA di `validateOtpEmail`, tidak pernah di `validateOtpPhone`.** Keduanya berakhir dengan baris `return` yang sama dan sisipan pertama sempat mendarat di jalur telepon — itu salah, dan bukan sekadar salah tempat: verifikasi telepon membuktikan sebuah nomor, sedangkan email di akun itu masih sekadar sesuatu yang diketik orang. Mengklaim di sana berarti menyerahkan tiket ke pemilik email yang belum terbukti.
- **Redirect shortlink mengarah ke EVENT, bukan ke jenis tiket.** `tracking_links.product_id` menunjuk satu jenis tiket karena kolomnya NOT NULL, tapi itu detail pembukuan; pengunjung harus mendarat di halaman yang memuat seluruh tiernya. Query UTM-nya tidak berubah, jadi atribusi tetap utuh. Kalau produk tiket ternyata tidak punya baris ticket type, ia jatuh kembali ke jalur `/product/<ref>` ketimbang ke beranda shop — link setengah jadi tetap harus mendaratkan orang di tempat yang bisa membeli.
- **Refund menjadikan tiket `VOID`, bukan `EXPIRED`.** Kursinya kembali ke kuota lewat mekanisme yang sama (kuota hanya menghitung `RESERVED` + `ISSUED`), tapi bedanya terbaca di daftar peserta backoffice: kursi yang dilepas sengaja bukan kursi yang kedaluwarsa.
- **Email pembeli yang sudah punya akun dipakai apa adanya**, aktif maupun placeholder. Order memang milik pemilik mailbox itu, dan menempelkannya tidak memberi akses apa pun — akun tetap butuh OTP sebelum bisa dimasuki.

### 15.3 R-17 — kode order bentrok saat checkout bersamaan (ditemukan + diperbaiki)

`generateOrderCode` menurunkan nomor urutnya dengan **menghitung** order hari itu, jadi dua checkout pada saat yang sama membaca hitungan yang sama dan mencetak kode yang sama; unique index lalu menolak salah satunya dengan P2002. Ini bukan teori: test balapan "dua pembeli merebut kursi terakhir" gagal karena ini, bukan karena kuota — yang kalah menerima `PrismaClientKnownRequestError`, bukan `EVENT_TICKET_SOLD_OUT`.

Docstring generator itu sudah menyebut bahayanya dan menyuruh pemanggil retry dengan jitter; `purchase-ingest.service.ts` melakukannya untuk banjir IAP-restore, tapi `CheckoutService.start` tidak. Untuk kursus itu jarang. Untuk event itu **normal**: satu link disebar ke broadcast list dan seluruh audiens menekan beli bersamaan.

Diperbaiki di `CheckoutService.start` (`createTransactionWithRetry`, 5 percobaan, jitter mulai percobaan kedua, dan **hanya** konflik pada kolom `code` yang di-retry). Perbaikan ini menguntungkan checkout kursus juga.

### 15.4 Catatan operasional

- **Test memakai database terpisah** (`localhost:5433/bb`) dari DB dev (`55432/bb_backend`). Migrasi harus dipasang di keduanya.
- **DB dev lokal sudah drift** jauh sebelum branch ini: 23 tabel ada di DB tapi tidak di `schema.prisma` (subscription, playlist, `bo_*`, dll) — sisa branch lain di DB yang sama. Tiga tabel event tidak termasuk; migrasi ini nol drift.
- **`tests/notification/topic-digest.spec.ts:265` merah sebelum branch ini** (dibuktikan dengan `git stash`). Bukan dari pekerjaan event.
- Sweeper BE-08 ikut lane cron **per jam**. Untuk event yang panas, kursi bisa tertahan sampai satu jam setelah ordernya kedaluwarsa. Kalau itu jadi masalah nyata, pindahkan namanya ke lane 5 menit — satu baris di `ecosystem.config.js` dan CDK.

---

## 16. Redirect setelah bayar (10 Sep 2026)

Diminta FE lewat `~/Downloads/event-payment-redirect-contract.md`. Masalahnya nyata
dan lebih tajam dari yang ditulis di sana: `env.xendit.invoiceSuccessUrl` default ke
`…/checkout/success`, dan `/checkout` masuk `PROTECTED_PATHS` di FE — jadi pembeli
tamu yang baru selesai bayar dilempar ke `/login` sambil memegang order yang sudah
lunas dan akun yang passwordnya tidak pernah ia buat. Redirect lama juga membawa
`transactionId` (UUID) dan **tidak membawa kode order sama sekali**, jadi halaman
tiket bahkan tidak bisa mencari ordernya.

Dua anggapan di dokumen FE sudah basi saat ditulis: `successRedirectUrl` /
`failureRedirectUrl` **sudah** di-set per-invoice (`payment.service.ts`), jadi itu
bukan kapabilitas baru; dan redirect itu tidak pernah membawa `code`.

### 16.1 Yang dibangun

- `PaymentService.create(memberId, dto, { redirect })` — override per-invoice,
  opsional. Kosong = perilaku `env.xendit.*` seperti sekarang, jadi **jalur kursus
  tidak berubah sama sekali**. Pemanggil yang menentukan, bukan PaymentService yang
  menebak dari tipe produk: pemanggil sudah tahu apa yang ia jual, menebak berarti
  satu query lagi untuk mengetahui hal yang sudah diketahui.
- `EventCheckoutService.orderPageRedirect()` — `${shop.baseUrl}${event.orderPath}/<code>?t=<token>`,
  dipakai untuk success DAN failure (halaman itu sudah merender EXPIRED/CANCELED dan
  menawarkan ulang `invoiceUrl` selama PENDING).
- `packages/common/src/utils/event-order-token.util.ts` — HMAC-SHA256 atas
  `code|exp`, base64url, dibanding `timingSafeEqual`. **Ditandatangani, bukan
  dienkripsi**: tetangganya `media-token.util.ts` menyegel dengan AES-GCM karena
  `guid` Bunny di dalamnya harus rahasia, sedangkan di sini kode order sudah ada di
  path URL — tidak ada yang disembunyikan.
- `GET /api/event/order/:code` menerima **tiga** kredensial, cukup salah satu:
  bearer (member pemilik order), `t`, atau `email` payer.

### 16.2 Kenapa begitu, bukan yang lain

- **Path tetap `/event/order/<code>`.** Usul FE `/ticket/<code>` bukan gratis:
  bb-comms sudah hardcode path itu di dua handler Go (`event_ticket_issued.go`,
  `event_order_summary.go`) plus dua template, dan repo itu langkah 2 di urutan
  rilis yang mengikat. Argumen "sekali masuk invoice jadi permanen" juga terlalu
  kuat untuk redirect: invoice tiket hidup 30 menit. Yang benar-benar permanen itu
  **link di email**.
- **Token, bukan email di URL.** `email` di URL bekerja hari ini tapi: (a) jadi
  bearer credential di history/Referer/script analytics, dan (b) **404 untuk pembeli
  yang login tapi mengisi contact email berbeda** — checkout terautentikasi
  mengabaikan blok `buyer`, jadi payer email = email akun, sementara stash FE
  menyimpan yang diketik. Token tidak punya ambiguitas itu.
- **Link email tetap `?email=`.** Token di sana memaksa bb-comms ikut memegang
  signing key (env + crypto Go) tanpa manfaat: penerima email sudah pemilik mailbox
  itu.
- **TTL token 24 jam, bukan 30 menit.** Token dicetak saat invoice dibuat dan URL
  redirect yang sedang terbang tidak bisa ditukar, jadi TTL harus melewati seluruh
  window bayar + pendaratan + polling. Halamannya read-only.
- **Verifier mengembalikan `null`, tidak pernah throw.** Endpoint ini menjawab 404
  yang SAMA untuk kode tak dikenal, email salah, dan token rusak — 401 dari verifier
  justru membocorkan bedanya.
- **Kunci diturunkan, URL-nya di `app_settings`.** Kuncinya
  `sha256('event-order-token|v1|' + JWT_ACCESS_SECRET)` — nol env var baru, nol entry
  Secrets Manager, nol langkah tambahan saat deploy. Label itu domain separation:
  kunci ini tidak bisa menandatangani JWT, dan kalau bocor induknya tidak terbongkar.
  Menandatangani dengan `env.jwt.accessSecret` langsung **tidak boleh** —
  `verifyAccessToken` mengecast payload tanpa memeriksa bentuknya, jadi tokennya akan
  ikut dipercaya jalur auth. Menaruh kuncinya di `app_settings` juga ditimbang lalu
  ditolak: baris `app_settings` ikut di **setiap dump database** (proyek ini punya 3 DB
  dan rutin menyalin antar-DB), sedangkan kunci ini menempa token untuk kode order
  **apa pun** — dan kode order itu counter per hari yang bisa dienumerasi, jadi yang
  terbuka adalah nama + email seluruh peserta. URL-nya sebaliknya: memang ingin bisa
  diubah tanpa redeploy. Konsekuensi yang perlu diketahui: rotasi `JWT_ACCESS_SECRET`
  ikut membatalkan token order yang sedang terbang, maksimal 24 jam — rotasi itu
  sendiri sudah melogout semua member, jadi bukan jenis gangguan baru.
- **400 untuk nol kredensial, 404 untuk kredensial salah.** 400 tidak bergantung
  pada ada-tidaknya kode, jadi bukan oracle.

### 16.3 Masih terbuka

- **Tidak ada rate limiter** di `GET /api/event/order/:code` (dipertimbangkan, lalu
  sengaja dilewati). Kode order bisa dienumerasi (`BB-YYYYMMDD-####`), dan halaman
  itu menampilkan nama + email peserta. Yang menahan hanya keharusan kredensial.
- **`event.orderPath` hanya memindahkan redirect.** bb-comms membangun link email
  dari `SHOP_BASE_URL` miliknya sendiri + `/event/order/` yang hardcode, jadi
  memutar setting itu tidak memindahkan email yang sudah terkirim. Kalau path benar
  benar pindah, bb-comms harus ikut diubah.
- FE harus `history.replaceState` membuang `t` setelah dibaca; backend tidak bisa
  memaksakan itu.

---

## 17. Bundling: tangga harga (10 Sep 2026)

Dari PRD §15. Dibangun di backend; backoffice (BO-04) dan marketplace (MP-05) belum.

### 17.1 Yang dibangun

- `event_ticket_price_tiers` — `min_qty`, `total_price`, `label`, unique per
  `(ticket_type_id, min_qty)`, `ON DELETE CASCADE` ke jenis tiketnya. **Tidak ada
  baris untuk qty 1**: harga itu tetap `products.price`, satu sumber kebenaran.
  Migration `20260910160000_event_ticket_price_tier`.
- `computeTicketItemTotal` (`packages/domain/src/event/price-tier.ts`) — harga
  termurah untuk `qty` tiket + `breakdown`-nya.
- `computeTotals` dapat parameter **opsional** `itemTotal`. Absen = `unitPrice × qty`
  seperti sebelumnya, jadi checkout kursus tidak berubah sama sekali.
- `StartCheckoutInput.itemTotal` meneruskannya; `EventCheckoutService` yang menghitung.
- `priceTiers` di payload `GET /api/event/:slug` dan `/on-sale`.
- `GET /api/event/quote?ticketTypeId=&qty=` — publik, read-only.

### 17.2 Kenapa DP, bukan greedy seperti di PRD

PRD §15.3 mengklaim: dengan tangga monoton (harga per tiket tidak naik saat
`minQty` naik), ambil-paket-terbesar-dulu = termurah. **Klaim itu salah.**

```
unit 200.000, tangga { 4 → 600.000 (150rb/tiket), 5 → 700.000 (140rb/tiket) }
monoton ✓   paket < satuan ✓   (semua validasi PRD lolos)

qty 8  greedy : 5 + 3×satuan = 1.300.000
       optimal: 4 + 4        = 1.200.000
```

Greedy gagal tiap kali ada **lubang** di bawah paket terbesar — bentuk yang wajar
kalau ops cuma menawarkan "paket 4" dan "paket 5". Karena janji produknya
(§15.1) adalah kombinasi termurah, algoritmanya harus benar-benar mencarinya.

Jadi: DP min-cost atas `1..qty`. `qty` dibatasi cap peserta (50) dan tangganya
segelintir baris, jadi ini aritmetika, bukan biaya yang perlu dioptimalkan. Seri
diselesaikan ke paket yang lebih besar — harga sama, struk lebih enak dibaca.

Konsekuensinya: **monotonisitas berhenti jadi load-bearing.** Validasi di
backoffice tetap berguna untuk menolak tangga ngawur, tapi kalau satu baris lolos,
pembeli tetap dapat harga termurah — baris buruknya sekadar tidak pernah terpakai.
Itu menurunkan validasi dari "penjaga kebenaran harga" jadi "penjaga kewarasan
data", dan itu tempat yang jauh lebih aman untuk sebuah validasi.

### 17.3 Yang ternyata tidak perlu disentuh

- **Komisi affiliate.** `payment-success.listener.ts` menurunkan basis komisi dari
  `acceptedAmount ?? amount` **order**, bukan `products.price`. Jadi order berpaket
  otomatis dihitung benar kalau nanti tiket punya program affiliate (P4).
- **Laporan pendapatan backoffice.** `listEvents` memakai
  `SUM(tx.item_total - tx.voucher_amount)` dari baris order.
- **Kuota + data peserta.** Sudah per tiket; paket Trio makan 3 kursi karena
  `qty` = panjang `attendees`.
- **Order yang sudah dibayar.** `item_total` dibekukan di baris order, jadi mengubah
  tangga tidak pernah menulis ulang penjualan yang sudah terjadi. Kunci-setelah-ISSUED
  di backoffice itu soal konsistensi laporan, bukan koreksi.

### 17.4 `/quote` tanpa voucher — sengaja

PRD §15.4 menaruh `voucherCode` di `/quote`. Tidak dibangun, dua alasan:

1. **Jadi oracle voucher publik.** Validasi voucher hari ini ada di balik
   `authGuard` + `voucherValidateRateLimiter`. Endpoint publik yang menerima kode
   memberi cara gratis tanpa login untuk menebak kode hidup dan membaca diskonnya.
2. **Tidak bisa menjawab benar.** `voucherService.validate(code, productId, memberId)`
   mewajibkan `memberId` — TRIAL sekali-per-member. Tamu tidak punya, jadi jawabannya
   paling banter indikatif dan checkout bisa menolak voucher yang tadi tampak sah.

Keputusan produknya belum diambil (1 = tanpa voucher, 2 = dengan voucher + limiter
dan dikontrakkan indikatif, 3 = preview hanya untuk yang login). Yang dibangun =
opsi 1, satu-satunya yang tidak menambah paparan. Menambahkannya nanti ~10 baris.

### 17.5 Backoffice (BO-04, selesai)

`backoffice-bb` branch `feat/events`:

- Section **Paket (opsional)** di form jenis tiket (`components/ticket-type-form.tsx`),
  read-only kalau sudah ada tiket ISSUED. Baris kosong dibuang di klien, bukan
  ditolak server — baris setengah jadi yang ditinggalkan operator bukan error.
- Kolom ringkas **Paket** di tabel jenis tiket (`Duo 350rb · Trio 500rb`, atau `—`).
- `validatePriceTiers` — `minQty ≥ 2`, unik, `totalPrice < minQty × satuan`,
  **`minQty ≤ maxPerOrder`** (tidak ada di PRD: tangga di atas cap itu baris mati,
  tidak ada pembeli yang bisa mencapainya), plus monoton. Tiap pesan menyebut
  **nomor barisnya**, karena operator mengisi beberapa sekaligus.
- Tangga dikunci bersama harga satuan setelah ada ISSUED, dibandingkan pada
  **qty + harga saja** (`tiersChanged`) — ganti label "Duo" → "Paket Duo" tidak
  memindahkan uang, jadi tetap boleh setelah penjualan.
- `priceTiers: undefined` = biarkan tangga tersimpan; `[]` = tidak ada paket.
  Pembedaan itu penting supaya pemanggil yang tidak mengurus paket tidak menghapus
  tangga orang lain.

Jebakan yang ketangkap saat verifikasi: `WHERE ticket_type_id = ANY(${ids})`
**gagal keras** dengan `42883 operator does not exist: uuid = text` — postgres.js
mengirim array string JS sebagai `text[]`. Tanpa `::uuid[]`, `getEvent` akan 500 di
setiap halaman detail event yang punya jenis tiket. Semua `ANY()` lain di file itu
membandingkan kolom text, jadi tidak ada preseden yang memperingatkan.

### 17.6 Masih terbuka

- MP-05 (kartu paket + tombol cepat + stepper + ringkasan dari `/quote`).
- `/quote` tidak memeriksa sisa kuota. Kalau ternyata menyesatkan di lapangan,
  tambahkan sebagai peringatan, jangan sebagai penolakan.

### 17.7 Komisi affiliate ditutup untuk tiket (11 Sep 2026)

PRD §4.4 (P4) memperkirakan tiket otomatis bebas komisi karena tidak punya baris
`affiliate_programs`. **Premis itu salah untuk repo ini.** Commit `2e74448`
(21 Mei 2026) membuat semua produk affiliate-able:

```
// Option B: any product is affiliate-able — `programId` is optional metadata, not a gate.
```

Gerbangnya **seed**: kode affiliate saat checkout, atau `members.inviter_id` pembeli.
Terukur sebelum diperbaiki: **0 program** untuk produk tiket, tapi **3 baris komisi
PENDING di tarif 30%** pada penjualan tiket — dari satu-satunya pembeli tiket yang
punya inviter.

Jadi rantai kesimpulan PRD-nya putus di mata rantai terakhir, dan konsekuensinya
"tidak ada perubahan kode" ikut salah: justru **butuh** perubahan kode.

`commitCommissionsForPayment` sekarang berhenti lebih awal kalau
`isEventTicketOrder(productId)`. **Dua pintu ditutup sekaligus** — inviter dan
override per-pembelian — karena menutup satu saja menyisakan tiket yang membayar
komisi tepat kepada orang yang mempromosikannya.

Tipe produk **dibaca di dalam service**, bukan dioper: argumen yang sama dengan
`isEventTicketOrder` dan `loadTrialGrant` — input opsional terbaca "bukan tiket" oleh
pemanggil yang lupa mengisinya, dan yang ini soal uang.

Niat P4 tidak berubah: skema tiket tetap direncanakan **nominal tetap**
(`commission_mode` + `fixed_amount` di level program, satu cabang di `computeAmount`,
tanpa tier PERFORMANCE/GROWTH). Blok ini yang membuat "tidak ada komisi saat rilis"
jadi benar sampai skema itu dibangun.

**Masih terbuka:** baris komisi yang terlanjur tertulis dibiarkan. Mem-VOID-nya
keputusan data, dan prod harus dihitung dulu dengan query yang sama.
