# Checkout Tax (PPN) — analisa contract FE & rencana BE

> Hasil review contract FE `checkout-tax-contract.md` (ditulis FE 2026-09-28) terhadap kode `main` per 2026-09-28.
> Status: **DIBANGUN 2026-09-29/30** di branch `feat/checkout-tax` (rate ship `0`, belum di-merge, migration belum di-apply). Kedua keputusan bisnis sudah masuk: base komisi pre-tax (§6.1) dan **tiket event bebas PPN** (§6.2). Tidak ada keputusan pending di sisi BE.
> Scope: course checkout, event tickets, riwayat transaksi. **Subscription di luar scope** (`feat/subscription` belum merge ke `main`; `prorationCredit` tidak ada di `main`).
> Dokumen terkait: `docs/commerce-port.md` (checkout + Xendit + voucher bypass), `docs/event-ticketing.md` §17 (price ladder), `docs/event-ticketing-contract.md`, CLAUDE.md §5.

---

## 0. Ringkasan

Pajak ditambahkan **di checkout, bukan di harga katalog**. Rumus dari contract:

```
taxBase   = itemTotal − voucherAmount          (tidak pernah < 0)
taxAmount = round(taxBase × taxRate / 100)     (half-up, rupiah bulat)
amount    = taxBase + taxAmount                (tax-inclusive; ini yang masuk invoice Xendit)
```

Kode hari ini **tidak punya konsep pajak sama sekali** (`grep -ri "tax|ppn"` = 0 hit). Kabar baiknya: seluruh perhitungan harga sudah lewat **satu fungsi**, `computeTotals` (`packages/domain/src/commerce/utils/compute-totals.ts`), yang dipakai course submit maupun event checkout. Tambah pajak di situ = ketiga flow (course, event, riwayat) otomatis konsisten.

Perubahan skema: **2 kolom** di `commerce_transactions`, tanpa tabel baru. Rate = `app_settings` (`tax.rate`), seed `0`, sehingga BE bisa rilis duluan tanpa mengubah apa pun untuk pembeli (rollout §6 contract step 1).

---

## 1. Kondisi kode vs contract

| Area | Kode sekarang | Dampak |
|---|---|---|
| Perhitungan | `computeTotals` → `amount = max(0, itemTotal − voucherAmount)`. Course: `itemTotal = price × qty`. Event: `itemTotal` dari `computeTicketItemTotal` (ladder). | Satu titik tambah `taxRate`/`taxAmount`. |
| Kolom order | `commerce_transactions`: `item_total`, `shipping_total`, `fee_total`, `voucher_amount`, `amount`. | Belum ada `tax_*`. |
| Invoice Xendit | `PaymentService.dispatchInvoice` kirim `amount: tx.amount`, `fee: 0`, `description: "Commerce <txId>"`, tanpa `items`/`fees`. | Begitu `amount` tax-inclusive, invoice otomatis benar (§2.10 ✅). |
| Webhook | `verifyPaidAmount`: `Math.round(paid_amount) === tx.amount`, fail-closed. | Tetap konsisten, tidak perlu ubah. |
| Voucher bypass | `amount === 0` → `completeVoucherBypass`, tanpa Xendit. | `taxBase = 0` → `taxAmount = 0` → jalur 100% voucher / TRIAL aman (T-03, T-04). |
| Ingest (IAP / Scalev / Lynk.id) | `purchase-ingest.service.ts` tulis `itemTotal = amount = gross` langsung, **tidak lewat `computeTotals`**. | `tax_*` tetap 0 untuk semua channel ingest. Sesuai contract untuk Apple; Scalev/Lynk.id ikut 0 — harus disebut eksplisit. |
| Komisi affiliate | `payment-success.listener.ts:57`: `commissionBase = acceptedAmount ?? amount`; `productPrice = commissionBase + voucherAmount` → `computeAmount` = `floor(amount × rate / 100)`. | **Komisi dihitung dari `amount`** → ikut naik kalau `amount` tax-inclusive. Lihat §6.1. |
| Email (bb-comms) | `CoursePaymentSuccess`, `EventOrderSummary`, `SaleAlert`, `CommerceRefunded` hanya kirim `refId`; bb-comms baca `commerce_transactions` sendiri dan render money block. | bb-comms **harus belajar kolom baru**, kalau tidak email tampil total tax-inclusive tanpa baris PPN. |
| Backoffice-bb | Report revenue / Sumber Traffic / orders = `SUM(amount)` raw SQL. | Revenue jadi gross-of-tax diam-diam. Perlu keputusan: revenue = `amount − tax_amount`. |

---

## 1b. Daftar API yang berubah / ditambah

Semua perubahan **additive**. Request body tidak ada yang berubah. Semua field amount = `number`. Order lama return `0`.

**Ditambah (1):**

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| `POST` | `/api/member/product/checkout/quote` | bearer + rate limiter | `{productId, voucherCode?}` | Sama seperti submit **minus** `transactionId`, `transactionCode`, `expiredAt`. Tanpa write, tanpa reserve voucher. Voucher invalid → 400 yang sama dengan submit. |
| `POST` | `/api/member/product/checkout/quote/public` | **tanpa auth** + rate limiter per IP (ditambah 2026-10-01) | `{productId, voucherCode?}` | Bentuk dan angka sama persis dengan quote ber-auth untuk produk + voucher publik yang sama. Guard already-owned dilewati; voucher ber-`ownerMemberId`/`campaign` dijawab identik dengan kode yang tidak ada; voucher `TRIAL` ditolak dengan alasan "masuk dulu". Tidak pernah 401. Kontrak FE: `docs/checkout-quote-public-contract.md`. |

**Berubah (7):**

| Method | Path | Field baru | Catatan |
|---|---|---|---|
| `POST` | `/api/member/product/checkout/submit` | `taxRate`, `taxAmount` | `amount` jadi tax-inclusive |
| `GET` | `/api/event/quote` | `taxRate`, `taxAmount`, `amount` | `breakdown` tetap pre-tax; publik |
| `POST` | `/api/event/checkout` | `taxRate`, `taxAmount` | `amount` jadi tax-inclusive |
| `GET` | `/api/event/order/:code` | `taxRate`, `taxAmount` | halaman order publik |
| `GET` | `/api/member/payment/commerce/list` | `taxRate`, `taxAmount` | otomatis dari raw Prisma row |
| `GET` | `/api/member/payment/commerce/:transactionId` | `itemTotal`, `voucherAmount`, `taxRate`, `taxAmount` | hari ini hanya `amount` |
| `POST` | `/api/member/payment/commerce` | — | tidak ada field baru; invoice Xendit dibuat atas `amount` tax-inclusive |

**Tidak diubah:** `POST /api/member/payment/voucher/validate` (fallback §2.3 contract tidak dipakai), `product/list`, `product/course/detail`, event `/on-sale` + `/:slug` (harga katalog tetap pre-tax).

---

## 2. Gap per endpoint

| § contract | Endpoint | Sekarang | Perlu |
|---|---|---|---|
| 2.1 | `POST /api/member/product/checkout/submit` | `StartCheckoutResult` `{transactionId, transactionCode, itemTotal, voucherAmount, amount, expiredAt}` | + `taxRate`, `taxAmount` |
| 2.2 | `POST /api/member/product/checkout/quote` | **tidak ada** | Endpoint baru. `authGuard` + rate limiter (voucher oracle — alasan yang sama dengan `/voucher/validate`). Isi = guard produk + `PRODUCT_ALREADY_PURCHASED` + `voucherService.validate` + `computeTotals`, **tanpa write**. Voucher invalid → **400 yang sama dengan submit** (`errorCode` + `details.reason`), bukan sub-object `voucher` — satu code path, FE sudah handle error submit. |
| 2.3 | `POST /api/member/payment/voucher/validate` | — | **Tidak diubah.** 2.2 dibangun, fallback tidak dipakai. |
| 2.5 | `GET /api/event/quote` | `{qty, itemTotal, breakdown}` | + `taxRate`, `taxAmount`, `amount`. `breakdown` tetap pre-tax. Endpoint publik → rate terekspos, tidak masalah. |
| 2.6 | `POST /api/event/checkout` | `EventCheckoutResult` meneruskan `order.amount` | + 2 field; otomatis kalau `StartCheckoutResult` diteruskan. |
| 2.7 | `GET /api/event/order/:code` | `select` hanya `amount` | + `select` & return `taxAmount`, `taxRate`. |
| 2.8 | `GET /api/member/payment/commerce/list` | `okPaginated(res, rows)` = **raw Prisma row** | Kolom baru muncul sendiri setelah migration + `prisma generate`. Tinggal update `CommerceTransactionListItemDto` (dokumentasi OpenAPI). |
| 2.9 | `GET /api/member/payment/commerce/:transactionId` | hand-picked, hanya `amount` | + `itemTotal`, `voucherAmount`, `taxAmount`, `taxRate`. |
| 2.10 | `POST /api/member/payment/commerce` | `amount: tx.amount` | Tidak ada perubahan. |

---

## 3. Koreksi ke FE

1. **Submit response BUKAN string.** Contract §2 bilang "checkout submit response already returns amounts as strings". Salah: `StartCheckoutResultDto` bertipe `number` dan controller `okCreated(res, result)` tanpa konversi. **Semua amount = number** di semua endpoint. Abaikan kolom "Type: string" di tabel 2.1.
2. **`prorationCredit` tidak ada di `main`.** Untuk course/event jangan diharapkan; field itu milik subscription (branch terpisah).
3. **Rollout §6 kurang satu repo:** bb-comms render money block dari DB sendiri (§1), jadi harus ikut rilis. Urutan binding di §7.
4. **Label "Harga belum termasuk PPN"** perlu juga di halaman event (`/on-sale`, `/:slug` menampilkan `price` per jenis tiket), bukan hanya product page.
5. **Refund** (`CommerceRefunded`) = `tx.amount` tax-inclusive. Wajar (pajak dikembalikan), tapi sebut di contract.

---

## 4. Jawaban usulan untuk §5 contract ("Open questions for BE")

| # | Pertanyaan FE | Jawaban |
|---|---|---|
| 1 | Rate & rounding | Rate = `app_settings` key `tax.rate` via `SettingsService` (pola sama `disbursement.fee`), **seed 0**. Rounding = `Math.round` (half-up untuk bilangan positif), rupiah bulat. Catatan: PPN nominal 12% dengan DPP 11/12 → efektif 11%; simpan rate sebagai `NUMERIC(5,2)`, bukan `INT`, supaya rate non-bulat tidak nyangkut. |
| 2 | Payment fee dalam base? | **Di luar base.** `fee`/`feeTotal` hari ini hardcode `0`; pembeli tidak pernah kena gateway fee. |
| 3 | Base komisi affiliate | **Ya, hari ini dari `amount`.** Harus diubah bersamaan (§6.1). Rekomendasi: `amount − taxAmount`. |
| 4 | Quote endpoint 2.2 satu release? | **Bisa.** ±40 baris, tanpa write. |
| 5 | Order lama | `taxAmount: 0`, `taxRate: 0` (kolom `DEFAULT 0`). Tanpa backfill, field tidak pernah dihilangkan. |
| 6 | Exemption per produk | Tidak ada sekarang. Rate global, tapi masuk sebagai **input `computeTotals`** supaya per-produk nanti = satu argumen (§6.2). |
| 7 | Invoice / receipt line | Xendit: `description` = `Commerce <txId>`, tanpa line items; bisa tambah `items` + `fees:[{type:'PPN', value}]` agar halaman Xendit tampil rincian — **opsional, defer**. Email: **wajib** (bb-comms, §1). |

---

## 5. Perubahan database

Tidak ada tabel baru. Dua kolom di `commerce_transactions`:

| Kolom | Tipe | Default | Fungsi |
|---|---|---|---|
| `tax_rate` | `DOUBLE PRECISION` (Prisma `Float`) | `0` | Rate yang berlaku saat order dibuat, **dibekukan** |
| `tax_amount` | `INT` | `0` | Rupiah pajak, **dibekukan** |

Migration `20260929120000_commerce_tax`. Plus dua baris seed `app_settings` (`prisma/seed-settings.ts`) — data, bukan DDL:

| Key | Seed | Fungsi |
|---|---|---|
| `tax.enabled` | `false` | **Saklar.** Mati = semua order baru rate 0, apa pun `tax.rate`. Dicek pertama di `resolveTaxRate`. |
| `tax.rate` | `0` | Persen (11 = 11%). Boleh diisi lebih dulu sebelum go-live. |

Dua key supaya rate bisa disiapkan sebelum go-live dan mematikan pajak = satu flip tanpa kehilangan rate. Go-live = `UPDATE app_settings SET value='true' WHERE key='tax.enabled'` (rate sudah 11), berlaku ≤60 detik. Rollback = `'false'`. Order yang sudah dibuat tidak bergerak dua arah.

`Float`, bukan `NUMERIC(5,2)` seperti draft awal: `GET /payment/commerce/list` mengembalikan raw Prisma row, dan `Decimal` Prisma ter-serialisasi ke JSON sebagai **string** — melanggar "semua amount number". Rate 11 / 11.5 / 12 eksak di double; perkalian `taxBase × rate` dilakukan dulu, baru satu kali dibagi 100, supaya `.5` eksak tetap eksak sebelum `Math.round`.

Dibekukan di row, bukan dihitung ulang dari rate saat baca: kalau rate berubah, riwayat order dan struk tidak boleh ikut berubah — alasan yang sama dengan snapshot UTM/attribution di order (contract §3).

Yang **tidak** diubah: `commerce_payments` (`amount` sudah = `tx.amount`), `event_tickets`, `products` (harga katalog tetap pre-tax), order lama (default 0, tanpa backfill).

Kalau keputusan §6.2 jatuh ke pengecualian per produk yang permanen, baru pertimbangkan `products.tax_exempt`. Sebelum itu cukup resolve dari `products.type` di kode.

---

## 6. Keputusan bisnis yang PENDING

### 6.1 Base komisi affiliate

Hari ini komisi = `floor(amount × rate / 100)`. Kalau `amount` jadi tax-inclusive tanpa perubahan:

| Course 1.000.000, PPN 11%, rate 20% | `amount` | komisi |
|---|---|---|
| sekarang | 1.000.000 | 200.000 |
| setelah tax, **tanpa** fix | 1.110.000 | **222.000** |
| setelah tax, **dengan** fix | 1.110.000 | 200.000 |

Selisih 22.000/order = komisi dibayar atas pajak yang disetor ke negara, bukan pendapatan. Base pre-tax: `taxAmount` ada di `CommercePaymentSuccessEvent` (default 0), listener pakai `(acceptedAmount ?? amount) − (taxAmount ?? 0)`. Event ticket sudah 0 komisi (`isEventTicketOrder` guard), tidak terdampak. Channel ingest (IAP/Scalev) tidak pernah kirim `taxAmount` → 0, jadi base `acceptedAmount` (net Apple) tidak berubah.

**Status: DIPUTUSKAN 2026-09-29 — komisi tidak terpengaruh pajak. Diimplementasikan** di `payment-success.listener.ts`, test `listener-success.spec.ts` ("commissions the pre-tax base").

### 6.2 Tiket event kena PPN?

Contract FE memasukkan event (§2.5–2.7, T-07/T-08), tapi itu asumsi FE, bukan keputusan pajak. Webinar/workshop berbayar umumnya jasa kena pajak → PPN; event hiburan kena **pajak hiburan / PBJT daerah**, bukan PPN; pendidikan formal bebas PPN, non-formal tidak. Keputusan finance/legal.

**Status: DIPUTUSKAN 2026-09-30 — tiket event TIDAK kena PPN. Diimplementasikan:** `resolveTaxRate(productId)` mengembalikan 0 kalau `isEventTicketOrder(productId)` (dibaca dari `products.type`, bukan flag dari pemanggil — flag opsional yang lupa dikirim terbaca sebagai "bukan event" dan menagih pajak). Berlaku untuk event quote, event checkout, dan halaman order. Test: `event-checkout.spec.ts` "event tickets are exempt" (rate 11 → tiket tetap 0, course tetap 11). Field `taxRate`/`taxAmount` tetap ada di semua response event, nilainya 0 → FE sembunyikan baris.

### 6.3 Pembelian lewat store (RevenueCat, Scalev, Lynk.id): PPN 11% dari uang masuk

**Diputuskan finance 2026-09-30: PPN atas penjualan lewat store dibayar Brainboost sendiri, DPP = uang yang masuk** (`accepted_amount`; untuk channel yang tidak melaporkan net = gross), bukan harga konsumen. Store-store ini tidak bisa menambah baris PPN — harganya yang dinaikkan (inklusif). Awalnya hanya RevenueCat (user: "jangan sentuh Scalev"), lalu **diperluas ke semua channel ingest** pada hari yang sama ("pada pembayaran revenuecat dan scalev itu tidak ada ppn terpisah … handle untuk transaksi tersebut").

Mekanisme, di **kernel ingest** (`purchase-ingest.service.ts`), tanpa flag per adapter — berlaku untuk `/api/webhook/revenuecat` dan `/api/ingest/purchase` (Scalev, Lynk.id) sekaligus. `taxRate = resolveTaxRate(productId)` (0 saat saklar mati, 0 untuk event); **dua bentuk, dibedakan dari ada-tidaknya potongan store** (opsi B, 2026-09-30):
- **Ada potongan store** (`accepted < gross`, Apple/Google): aturan finance, `tax = round(accepted × r/100)` — eksklusif atas payout. RC 439.000 → payout 307.300 → PPN 33.803.
- **Tanpa potongan store** (`accepted == gross`, Scalev/Lynk.id): harga itu kita yang set, inklusif, persis seperti web → `tax = round(gross × r/(100+r))`, porsi **di dalam** harga. Scalev 330.780 → PPN 32.780, **identik dengan web** pada harga yang sama. Mengenakan 11% flat di sini = pajak dobel atas harga yang sudah mengandung PPN (bug yang sempat ada: 36.386).

Disimpan beku di `tax_rate`/`tax_amount`, di-emit di event. **Satu rate untuk semua storefront** (SGD/USD/…): PPN yang kita bayar adalah PPN Indonesia, apa pun mata uang pembeli. Kalau kelak Scalev melaporkan net setelah fee-nya (`accepted < gross`), baris itu otomatis pindah ke bentuk pertama.
- Listener komisi: base = `(acceptedAmount ?? amount) − taxAmount`, satu pengurangan flat untuk web dan IAP, karena `taxAmount` selalu dinyatakan atas angka yang sama dengan base-nya (web: atas `amount`; IAP: atas `accepted`).
- `tax_amount` di baris IAP = kewajiban PPN **kita**, sama maknanya dengan baris web → laporan PPN backoffice boleh `SUM(tax_amount)` lintas provider.

Contoh row prod nyata (BB-20260929-0049), rate affiliator 20%:

| | Nilai |
|---|---|
| Harga App Store (`amount`) | 399.000 |
| `accepted_amount` (RC takehome 0,7) | 279.300 |
| `tax_amount` = 279.300 × 11% | 30.723 |
| Base komisi = 279.300 − 30.723 | 248.577 |
| Komisi 20% | 49.715 (sebelumnya 55.860) |

Turun ~11%: selama ini affiliator IAP dibayar dari PPN yang harus kita setor. Alternatif yang dipertimbangkan lalu ditolak finance: DPP = harga konsumen (399.000 × 11/111 = 39.541, base `accepted ÷ 1,11` = 251.621).

**Catatan untuk finance, bukan kode:** akurasi `accepted_amount` sendiri (RC `takehome 0.7` vs `commission 0.2703 = 0,3 × (1 − 0.0991)` saling tidak konsisten soal siapa memotong pajak) hanya bisa direkonsiliasi dengan laporan payout App Store Connect. Rumus komisi di atas benar relatif terhadap `accepted_amount` apa pun nilainya.

**Data prod 2026-09-30** (176 order RC di `bb_backend`, query via dbx, read-only) yang mendasari:

| Currency | n | RC `tax_percentage` | = |
|---|---|---|---|
| IDR | 159 | 0.0991 | 11/111 → PPN 11% **sudah di dalam** harga App Store |
| SGD / MYR / AUD / AED | 8 | 0.0826 / 0.0741 / 0.0909 / 0.0476 | GST/VAT lokal masing-masing |
| USD / HKD | 8 | 0 | tanpa VAT |

RC `tax_percentage` per storefront = tarif pajak lokal dalam bentuk inklusif (IDR 11/111, SGD 9/109, …). Sempat dibaca sebagai "Apple sudah memungut PPN"; finance mengonfirmasi **tidak** — kewajibannya di kita. Implementasi tetap memakai satu rate dari `app_settings`, bukan `tax_percentage` RC, karena yang kita setor adalah PPN Indonesia.

### Semua sudah masuk

Migration 2 kolom, `computeTotals` + setting `tax.rate` (seed 0), field baru di semua response, endpoint quote 2.2, base komisi pre-tax, event exempt. Rate 0 = perilaku tidak berubah; flip ke 11% hanya menagih course.

---

## 7. Implementasi BE (selesai 2026-09-29, branch `feat/checkout-tax`)

`resolveTaxRate(productId)` (`packages/domain/src/commerce/tax.ts`) adalah satu-satunya tempat rate dibaca, dan satu-satunya tempat aturan "event tidak kena" hidup (§6.2). Base komisi pre-tax (§6.1): `CommercePaymentSuccessEvent.taxAmount` di-emit oleh kedua jalur commerce (bypass + webhook Xendit) dan dikurangkan di listener.

File yang disentuh:

- `prisma/schema.prisma` + migration `20260929120000_commerce_tax` — 2 kolom (§5).
- `packages/common/src/services/settings.service.ts` — `SETTING_KEYS.taxEnabled = 'tax.enabled'` (seed `false`) + `SETTING_KEYS.taxRate = 'tax.rate'` (seed `0`); `prisma/seed-settings.ts`.
- `packages/domain/src/commerce/tax.ts` — `resolveTaxRate(productId)`; 0 untuk `event_ticket` via `isEventTicketOrder`, else `tax.rate`. Dipanggil dari course price, event quote, dan kernel ingest.
- `apps/mobile-api/src/modules/ingest/purchase-ingest.service.ts` — `taxAmount = round(accepted × r/100)` untuk SEMUA purchase ingest (RC, Scalev, Lynk.id), simpan + emit. Tidak ada flag per adapter (§6.3).
- `packages/domain/src/commerce/utils/compute-totals.ts` — input `taxRate`, output `taxRate`, `taxAmount`, `amount` tax-inclusive. Tanpa `taxRate` hasilnya byte-identik dengan fungsi lama (ada test).
- `packages/domain/src/commerce/checkout.service.ts` — guard + aritmetika dipindah ke `price()` privat; `start()` dan `quote()` baru sama-sama lewat situ, jadi quote tidak bisa beda dengan submit. `start()` simpan `taxRate`/`taxAmount`.
- `packages/common/src/events/commerce-events.ts` — `taxAmount?` di `CommercePaymentSuccessEvent`. `packages/domain/src/commerce/listeners/payment-success.listener.ts` — base komisi `(acceptedAmount ?? amount) − (taxAmount ?? 0)` (§6.1, §6.3).
- `packages/domain/src/commerce/payment.service.ts` — `getTransactionStatus` return `itemTotal`, `voucherAmount`, `taxRate`, `taxAmount`; bypass emit `taxAmount`. `apps/mobile-api/src/modules/webhook/xendit.handler.ts` emit `taxAmount`.
- `apps/mobile-api/src/modules/commerce/` — route + controller `quoteCheckout` (`authGuard` + `voucherValidateRateLimiter` + `CheckoutQuoteDto`), `CheckoutQuoteResultDto` (di-extend `StartCheckoutResultDto`), field baru di `TransactionStatusResultDto` + `CommerceTransactionListItemDto`.
- `apps/mobile-api/src/modules/event/` — `EventService.quote()` sekarang lewat `computeTotals` + `resolveTaxRate()` dan mengembalikan `voucherAmount/taxRate/taxAmount/amount` sendiri (controller tidak lagi menambal `amount = itemTotal`); `getOrderByCode()` select + return 2 kolom; DTO quote/order/checkout. `packages/domain/src/event/event-checkout.service.ts` teruskan 2 field dari order.
- Tests: `compute-totals.spec.ts` (T-01/02/03/04/07 + rounding half-up + rate ≤ 0), `commerce/checkout.spec.ts` (quote tanpa write, error sama dengan submit, T-12 quote = submit = detail dengan rate 11, order beku saat rate diubah ke 12, T-09 order lama = 0), `event/event-checkout.spec.ts` (T-07 quote, T-08/T-10 checkout + invoice + order page, tiket gratis tetap 0).

**Urutan deploy (binding):**
1. Migration (kolom default 0, aman untuk kode lama).
2. **bb-comms** — baca `tax_amount`/`tax_rate`, render baris PPN hanya kalau > 0.
3. Backend (rate masih 0 → tidak ada perubahan untuk pembeli).
4. FE (baris PPN hidden saat 0).
5. Backoffice-bb — revenue net-of-tax (kalau diputuskan begitu).
6. Flip `tax.rate` di stage → QA T-01..T-11 → prod.

---

## 8b. Backoffice-bb (branch `feat/checkout-tax` di repo itu, 2026-09-30)

Hampir semua angka "revenue" di backoffice sudah `item_total − voucher_amount` (pre-tax) → tidak berubah. Yang diubah:

| Halaman / file | Perubahan |
|---|---|
| `/settings` → card **Pajak (PPN)** (`components/settings-tax.tsx`, `lib/tax-settings-queries.ts`, `app/api/settings/route.ts`) | Toggle `tax.enabled` + tarif `tax.rate`, perm `settings.view`/`settings.manage`, audit `settings.update` target `tax` dengan before/after. Peringatan saat menyalakan. |
| `/finance` | KPI baru **PPN Terutang** (`SUM(tax_amount)` PAID, + jumlah order); card "Revenue Bruto" → **"Harga Jual (sebelum diskon)"** (isinya pre-diskon + pre-PPN, dan kata "Bruto" di tabel kini berarti termasuk PPN); card **"Biaya Channel" dibuang** (`fee_total` selalu 0 → selamanya Rp 0); Outstanding/Gagal-Expired dan donut status diubah dari `SUM(amount)` → `item_total − voucher_amount` (satu basis pre-tax); subtitle "Revenue per Metode Bayar" diberi "(termasuk PPN)". Tetap 12 card. |
| `/transactions/[code]` | Baris **PPN r%** sebelum Biaya channel, **Tagihan pembeli = `amount`**; untuk RC: baris "PPN atas payout Apple (setoran kita)" di bawah total + sub-baris "PPN → bersih" di Estimasi Diterima. |
| `/transactions` KPI | Card baru **PPN** (Σ `tax_amount` order lunas dalam filter aktif + jumlah order) dan **Netto Lunas** (Σ Netto = payout/dibayar − PPN, dasar komisi; sub-teks selisih vs Nilai Lunas = potongan store + kredit prorata + PPN). **Nilai Lunas** tetap nilai penjualan `item_total − voucher` (sama dengan Revenue Bersih di Finance). **Estimasi Diterima IAP** = `accepted − tax`. Grid 5 kolom (2 baris). Diukur di staging Sep 2026: Nilai Lunas 99,79 jt vs Netto 73,81 jt — selisih = potongan Apple 13,47 jt + prorata upgrade langganan 12,38 jt + PPN 0,13 jt. |
| `/transactions` + export CSV | Kolom Nilai diganti **Bruto** (`amount`, tagihan yang dibayar; sub-teks `PPN 11%`, RC: `PPN 11% atas payout`; tanpa sub-teks bila 0; nominal PPN hanya di detail + export) dan **Netto** (`item_total − voucher`, sub-teks potongan voucher). Tidak ada kolom PPN sendiri. Export kolom baru `PPN (%)`, `PPN (IDR)`, `Total Tagihan (IDR)`. |
| `/members/[id]` pembelian | Kolom Net diganti **Bruto · Netto**, bentuk sama. |
| Marketing first-purchase-voucher "Omzet" | `SUM(t.amount)` → `item_total − voucher_amount`. |
| `/affiliate` card Revenue Affiliate (+ App) | Baris `bruto` → **`harga jual`** (isinya pre-tax); baris baru **`PPN payout (iOS)`** = Σ `tax_amount` baris RevenueCat (join `commerce_transactions` via `pay.transaction_id`, `taxExpr()`), dikurangkan ke angka utama → "bersih" iOS = `accepted − tax` = dasar komisi backend. Web tidak berubah (dasar komisi sudah pre-tax). Empat tabel atribusi (Top Affiliator, per produk, export) **tidak** dikurangi — memang tidak menjumlah ke card. |
| Transaksi Terbaru (finance) | Nilai = pre-tax, konsisten dengan tabel lain. |

**Definisi Netto (2026-09-30, koreksi):** `Netto = (accepted_amount jika > 0, else amount) − tax_amount` = **dasar komisi backend**. Web: `amount − tax` = `item_total − voucher` (angka lama, tidak bergerak). Store (RC/Scalev/Lynk.id): `payout store − PPN` — potongan Apple dan pajak sudah keluar. Contoh staging: RC 439.000 → netto 273.497; Scalev 330.780 → netto 298.000 (= web pada harga yang sama); web 330.780 → netto 298.000. Dipakai oleh list `/transactions` (kolom Netto + sort "amount"), KPI **Nilai Lunas**/AOV, export kolom `Nilai`, tabel pembelian `/members/[id]` dan `totalSpend` member. Sebelumnya `item_total − voucher` untuk semua baris, yang untuk baris store = harga store penuh (belum dikurangi apa pun).

Aturan tampil: PPN hanya muncul bila `tax_amount > 0`; label tarif dari `tax_rate` row, bukan konstanta. Di baris store `amount − tax_amount` **bukan** harga pre-tax — UI tidak pernah menurunkannya.

**Prasyarat runtime:** migration backend `20260929120000_commerce_tax` harus sudah ada di DB yang sama, kalau tidak query yang menyebut `tax_amount` gagal saat render (drift gotcha). Deploy backoffice ini **setelah** migration. Tidak perlu `pnpm db:setup` (tidak ada permission baru).

## 8. QA cases yang relevan BE (dari contract, tanpa subscription)

| # | Flow | Setup | Expect |
|---|---|---|---|
| T-01 | Course | tanpa voucher | `taxAmount = round(price × rate)`, `amount = price + tax` |
| T-02 | Course | voucher 50% | tax atas setengah harga |
| T-03 | Course | voucher AMOUNT > harga | tax 0, total 0, order PAID tanpa invoice |
| T-04 | Course | voucher TRIAL | tax 0, total 0, `trialDays` tampil |
| T-07 | Event | qty 5 dengan ladder | tax atas total ladder, satu baris, `breakdown` pre-tax |
| T-08 | Event | guest checkout | order page tampil baris tax |
| T-09 | Riwayat | order sebelum perubahan | `taxAmount: 0`, total tidak berubah |
| T-10 | Any | invoice Xendit | = `amount` tax-inclusive di summary card |
| T-11 | Any | product page, ticket list | harga tidak berubah, tanpa pajak |
