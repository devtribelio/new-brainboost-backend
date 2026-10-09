# PRD — Link Affiliate Subscription & Perbaikan Komisi Renewal

> Affiliator membagikan **satu link subscription**. Siapa pun yang mengklik link itu lalu membeli **tier mana pun** (SOLO/DUO/FAMILY/PREMIUM), di **web maupun app**, komisinya masuk ke affiliator tersebut. Link yang sama juga bekerja saat diklik dari browser: visit tercatat, cookie atribusi terpasang, lalu pengunjung mendarat di shop. Sekalian, bug komisi **40% berulang** untuk pelanggan yang langganannya sempat expired lalu membeli lagi diperbaiki menjadi **10%**.
> Status: **BE sudah diimplementasi** di branch `feat/batch-juli-jalur-a` (belum di-commit, test belum dijalankan). FE web + mobile belum dimulai. Backlog: project **BB**, prefix `[BE]` / `[FE]` / `[Mobile]`, label `subscription-affiliate`.
> Keputusan produk: 9 Okt 2026.
> Dokumen terkait: `docs/affiliate-link-contract.md` (kontrak teknis untuk FE/mobile), `docs/prd-subscription-backend.md` (PRD subscription Phase 1), `docs/subscription-port.md`, CLAUDE.md §5 (atribusi affiliate).

---

## 0. Ringkasan

Ada tiga masalah, dan ketiganya diselesaikan di backend tanpa mengubah kontrak yang sudah dipakai app:

| # | Masalah | Solusi |
|---|---|---|
| 1 | Pelanggan yang langganannya **expired lalu membeli lagi** dihitung sebagai penjualan pertama, sehingga affiliator dibayar 40% lagi, bukan 10% | Renewal = pembeli **pernah membayar** subscription apa pun, apa pun status langganannya |
| 2 | Web shop **tidak punya mekanisme affiliate apa pun**, sehingga link affiliate yang diklik dari browser tidak tercatat sama sekali | Link baru `GET /api/member/affiliate/link/<kode>/<produk>` yang dikerjakan sepenuhnya oleh backend: catat visit, pasang cookie, lalu redirect ke shop. Web shop tidak perlu diubah |
| 3 | Atribusi di app **ketat per produk**: klik link SOLO tidak dihitung kalau pembeli akhirnya membeli FAMILY | Keempat tier subscription diperlakukan sebagai **satu kelompok**, sama di web dan app. Ada juga link khusus `.../subscription` |

---

## 1. Latar belakang

### 1.1 Cara affiliator ditentukan (berlaku untuk semua produk)
Setiap pembelian dicek dengan tiga langkah. Langkah pertama yang menemukan affiliator yang dipakai.

1. **Kode affiliate eksplisit:** `affiliatorCode` di body checkout, atau cookie `bb_aff` di web (berlaku 365 hari, klik terakhir yang menang, tidak terikat produk).
2. **Riwayat klik (`affiliate_visits`)** milik pembeli untuk **produk yang sama persis**, dalam batas `affiliate.cookieDays` (365 hari).
3. **Inviter pembeli** (`members.inviter_id`, permanen).

### 1.2 Kondisi web shop hari ini: tidak ada mekanisme affiliate sama sekali
Diverifikasi di repo `brainboost-marketplace` (commit `18c9c47`, 2 Okt 2026):
- tidak ada kode yang membaca `affCode` dan tidak ada pemanggilan `POST /member/affiliate/visits`;
- checkout web (`services/checkout.api.ts:53-57` → `POST /api/member/product/checkout/submit`) hanya mengirim `productId` + `voucherCode`, tanpa kode affiliate;
- link "buka app" (`lib/app-link.ts`) sengaja tidak membawa kode affiliate.

Jadi seluruh atribusi pembelian web terjadi **di backend**, dengan kondisi sebagai berikut:
- **Langkah 1 praktis selalu kosong.** Backend sudah membaca cookie `bb_aff`, tapi tidak ada yang pernah membuat cookie itu di web.
- **Langkah 2 yang benar-benar bekerja,** tapi hanya kalau pembeli pernah mengklik link affiliate **di app**. Klik itu tercatat atas nama akunnya, sehingga ikut terbaca saat ia membeli di web.
- **Langkah 3 (inviter) menampung sisanya.**

Konsekuensinya, klik dari **browser** (desktop, WhatsApp Web, atau OneLink yang jatuh ke fallback web) **tidak pernah tercatat**. Selain itu, `shareUrl` dari endpoint share menunjuk ke `/p/<slug>`, path yang tidak ada di marketplace (halaman produk ada di `/product/<code>`).

### 1.3 Mengapa subscription butuh aturan sendiri
Subscription dijual sebagai satu penawaran dengan 4 tier, dan tiap tier adalah produk tersendiri. Halaman pembelian menampilkan keempat tier berdampingan, jadi pindah tier saat membeli adalah perilaku normal. Dengan aturan "ketat per produk" di langkah 2, affiliator kehilangan komisi setiap kali pembeli memilih tier lain dari yang di-share. Ini terjadi **di app maupun web**, karena di web pun satu-satunya atribusi yang jalan adalah langkah 2 yang sama.

### 1.4 Cara app bekerja (sudah ada, tidak diubah)
App sudah membuat dan membaca OneLink (`https://brainboost.onelink.me/ZL18/links?...&product=&affCode=`), lalu memanggil `POST /member/affiliate/visits` setelah dibuka.

---

## 2. Keputusan (terkunci, 9 Okt 2026)

1. **Definisi renewal untuk komisi subscription:** pembeli **pernah membayar** subscription, di langganan mana pun yang ia miliki, apa pun statusnya (ACTIVE / EXPIRED / CANCELED). Pengecualian:
   - **grant** (langganan gratis dari kampanye) tidak dihitung, jadi pembayaran pertama setelah grant tetap **40%**;
   - pembelian yang **direfund** tidak dihitung, jadi refund lalu beli lagi tetap **40%**.
2. **Rate tetap:** 40% penjualan pertama, 10% renewal dan pindah tier (keputusan COO 24 Agu 2026, kolom per plan di `subscription_plans`).
3. **Subscription = satu kelompok atribusi.** Klik pada plan subscription mana pun mengatribusikan pembelian **tier mana pun**, **sama di web dan app**. Komisi tetap dihitung dari plan yang **benar-benar dibeli**.
4. **Produk lain tetap ketat per produk, dua arah:** klik kursus tidak mengatribusikan subscription, dan sebaliknya.
5. **Jalur app tidak berubah:** app tetap memakai `POST /member/affiliate/visits`. Untuk subscription, app cukup mengirim `productCode: "subscription"`.
6. **Link browser lewat host shop** (`https://<shop>/api/...`), supaya cookie menempel di host yang sama dengan checkout web. Marketplace tidak perlu diubah.
7. **Inviter fallback tetap dipakai** untuk subscription.

---

## 3. Perilaku

### 3.1 Dua endpoint, logika yang sama

| | `POST /member/affiliate/visits` (sudah ada) | `GET /member/affiliate/link/<aff>/<produk>` (baru) |
|---|---|---|
| Dipanggil oleh | App, setelah OneLink dibuka | Browser, langsung saat link diklik |
| Bentuk | JSON + bearer | Link biasa |
| Respons | JSON status | Redirect 302 ke `<shop>/product/<kode>` |
| Catat visit | ✅ | ✅ |
| Cookie `bb_aff` | ✅ | ✅ |
| Kelompok subscription | ✅ | ✅ |

Keduanya memanggil `VisitService.logVisit` dan memakai aturan cookie yang sama (`setAffiliateCookie`).

### 3.2 Link browser: selalu redirect, tidak pernah error

| Kondisi | Visit | Cookie | Redirect |
|---|---|---|---|
| Kode + produk valid | dicatat | dipasang | halaman produk |
| Kode affiliate tidak dikenal | tidak | tidak | halaman produk |
| Produk tidak dikenal | dicatat tanpa produk | dipasang | `/products` |
| Bot / preview (WhatsApp, Telegram, Slack, crawler) | tidak | tidak | seperti biasa |
| Klik kode sendiri (hanya terdeteksi kalau ada bearer) | tidak | tidak | seperti biasa |
| Lebih dari 60 klik/menit per IP | tidak | tidak | seperti biasa |

### 3.3 Link subscription
- Ref khusus: `.../link/<aff>/subscription` (huruf besar/kecil tidak berpengaruh), atau `productCode: "subscription"` di POST.
- Klik dicatat pada **plan default** = plan aktif dengan seat paling sedikit (SOLO). Karena aturan kelompok, plan mana yang tercatat tidak memengaruhi komisi.
- Endpoint share (`POST /member/product/course/share`) mengembalikan field baru `affiliateLinkUrl`. Untuk produk subscription isinya otomatis link kelompok. `shareUrl` lama tidak berubah.

### 3.4 Contoh
> Ani share link subscription. Budi klik di HP, buka app, lalu beli **FAMILY** (Rp 1.999.000).
> Ani dapat **40% = Rp 799.600**. Setahun kemudian langganan Budi lewat masa grace dan expired. Dua minggu setelahnya Budi beli lagi, dan Ani (atau siapa pun yang tercatat saat itu) dapat **10%**, bukan 40%.

---

## 4. Task breakdown

| ID | Task | Pemilik | Status |
|---|---|---|---|
| BE-1 | Renewal = pernah bayar, minus grant & refund (`affiliator.service.ts` `hasPaidSubscriptionBefore`) + test | BE | ✅ kode, ⏳ test |
| BE-2 | Link `GET /member/affiliate/link/:affCode/:product`: visit + cookie + redirect, filter bot, rate limit, tidak pernah error + test | BE | ✅ kode, ⏳ test |
| BE-3 | Kelompok atribusi subscription di kedua pembaca visit (`attributionProductScope`, dipakai `AttributionService` + `CheckoutService.resolveAttribution`) + test | BE | ✅ kode, ⏳ test |
| BE-4 | Ref `subscription` → plan default (`VisitService.resolveProduct`) | BE | ✅ kode, ⏳ test |
| BE-5 | `affiliateLinkUrl` di endpoint share (link kelompok untuk subscription) | BE | ✅ kode, ⏳ test |
| BE-6 | Merge `main` ke branch (tertinggal 12 commit: alias kode affiliate, klik kode sendiri), jalankan test, lalu commit dalam 2 commit | BE | ⏳ |
| BE-7 | Samakan batas waktu `CheckoutService.resolveAttribution` (sekarang 30 hari hardcode) dengan `affiliate.cookieDays` | BE | ⏳ kecil |
| M-1 | `generateOneLinkUrl`: tambah `af_web_dp=<affiliateLinkUrl>` saat produk + affCode ada, supaya klik desktop tercatat | Mobile | ⏳ |
| M-2 | OneLink subscription memakai `product=subscription`. Saat dibuka, app membuka **layar pilihan paket** dan memanggil POST visit dengan `productCode: "subscription"` | Mobile | ⏳ |
| BE-8 | Endpoint share menerima `code: "subscription"` (daftar plan tidak membawa kode produk) + test | BE | ✅ kode, ⏳ test |
| M-3 | Tombol share di layar subscription memanggil share dengan `code: "subscription"` | Mobile | ⏳ |
| FE-1 | Halaman pilihan paket subscription di web shop (keempat tier). Setelah jadi, redirect link kelompok dipindah ke halaman ini | FE | ⏳ |
| DOC | Update CLAUDE.md §5 (aturan kelompok, definisi renewal, koreksi batas atribusi 30 → 365 hari) | BE | ⏳ |

Sampai FE-1 selesai, link subscription mendarat di halaman produk SOLO. Pembeli tetap bisa membeli tier lain dan tetap teratribusi.

---

## 5. Rencana test

Integration test dengan Postgres asli (tanpa mock DB):
- `flat-commission.spec.ts`: expired lalu beli lagi = [40, 10]; refund lalu beli lagi = 40; grant lalu bayar = 40; kasus lama tetap hijau.
- `per-product-attribution.spec.ts`: klik SOLO lalu beli FAMILY = teratribusi (kedua pembaca); klik kursus lalu beli subscription = tidak; klik subscription lalu beli kursus = tidak; klik kode sendiri tetap diabaikan.
- `affiliate-link.spec.ts`: link valid = 302 + visit + cookie; kode tidak dikenal = tanpa cookie; produk tidak dikenal = `/products`; bot = tanpa visit; ref `subscription` = plan default; `affiliateLinkUrl` subscription berakhir `/subscription`.

> ⚠️ Default DB test adalah `localhost:5433`, **port yang sama dengan tunnel staging**. Matikan tunnel sebelum menjalankan test, karena test menghapus data.

**QA manual (staging):**
1. Klik link dari desktop, lalu cek cookie `bb_aff` di host shop dan baris `affiliate_visits`.
2. Checkout tier lain di web, lalu cek komisi 40% ke affiliator.
3. Buka OneLink `product=subscription` di HP, lalu beli tier lain lewat IAP sandbox, dan cek komisinya.

---

## 6. Rilis

- Tidak ada migrasi database dan tidak ada perubahan bentuk respons (field `affiliateLinkUrl` hanya tambahan).
- BE bisa deploy duluan tanpa menunggu mobile atau FE. Link bisa langsung dipakai dari browser.
- Hanya pembelian **setelah** deploy yang terdampak. Komisi yang sudah tercatat tidak dihitung ulang.

---

## 7. Belum diputuskan (di luar scope PRD ini)

1. **Penguncian affiliator untuk renewal.** Saat ini penerima komisi renewal dicari ulang setiap pembayaran, sehingga setahun kemudian sering jatuh ke inviter, bukan ke affiliator penjualan pertama. Perlu keputusan COO.
2. **Refund iOS.** Komisi app sudah bisa ditarik setelah 35 hari, padahal Apple bisa me-refund belakangan, sehingga saldo affiliator bisa minus. Perlu aturan penagihan dan cara menampilkan saldo minus.
3. **Kebijakan tanpa refund di web.** Alur refund Xendit memang belum ada. Perlu ditulis sebagai kebijakan resmi.
4. **Harga iOS.** Kenaikan +30% +11% belum menyamakan komisi dengan web (sekitar Rp 359K vs Rp 399,6K untuk SOLO), karena potongan Apple dihitung dari harga yang sudah naik. Perlu dihitung ulang bersama finance.
5. **Fraud lewat akun kedua** (beli lewat link sendiri dari akun lain). Masa tahan 7 hari mungkin terlalu pendek untuk komisi Rp 1,1 juta.
6. **Cookie web tidak terikat produk** (solusinya ditulis di `docs/prd-web-affiliate-parity.md`, belum dijadwalkan). Setelah link GET aktif, cookie `bb_aff` mulai benar-benar dibuat di web. Cookie ini dibaca checkout sebagai kode eksplisit (langkah 1) untuk **produk apa pun**, sehingga klik link kursus bisa mengatribusikan pembelian subscription berbulan-bulan kemudian. Ini perilaku baru di web (sama dengan legacy). Perlu diputuskan apakah dibiarkan atau cookie dibatasi per produk.
7. **Copy notifikasi/email renewal di web.** Tanda "renewal" hanya datang dari RevenueCat, jadi renewal lewat web dapat copy "Pembayaran berhasil", bukan "Langganan diperpanjang".
