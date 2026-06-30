# Affiliate Over-Attribution — Frontend (Flutter `brainboost-apps`) Action Items

**Untuk:** tim mobile `brainboost-apps`
**Terkait backend:** `new-brainboost-backend` branch `feat/affiliate-overattribution-fix` (commit `ff707e6` B-2/B-3, `ec28d20` B-5, + strict per-product)
**Spec lengkap (root cause + backend):** `docs/affiliate-overattribution-fix.md`

---

## 🚨 PALING PENTING — M-4 sekarang WAJIB (blocking)

Backend memakai **STRICT per-product attribution**: komisi affiliate **hanya** diberikan jika ada `AffiliateVisit` yang **terikat ke produk yang dibeli**. Visit **tanpa `productCode`** (product-less) **tidak menghasilkan komisi affiliate sama sekali**.

Artinya: **sampai app mengirim `productCode` saat log visit (M-4), semua penjualan affiliate via app BERHENTI ter-atribusi** (jatuh ke inviter). Build app lama yang tak pernah update → permanen tak terhitung.

➡️ **M-4 harus di-rilis bersamaan / sebelum backend strict ini live.** Koordinasikan dengan tim backend.

---

## TL;DR

Affiliate dibayar untuk pembelian yang **bukan** hasil referral mereka. Akar masalah: `affiliate_code` disimpan sebagai **RevenueCat subscriber attribute** yang **sticky** → ikut di setiap event RC berikutnya.

Backend sudah diperbaiki (tidak lagi membaca attribute itu; attribusi via `AffiliateVisit` per-produk). Yang dibutuhkan dari app:

1. **M-4 (WAJIB):** kirim `productCode` di payload visit → attribusi per-produk jalan.
2. **M-1/M-2 (housekeeping):** clear attribute RC setelah dipakai.

---

## M-4 — Kirim `productCode` saat log visit *(blocking)*

App sudah menangkap product dari OneLink (`appsflyer_service.dart` → `setAffiliateRedirectProductCode`), tapi saat log visit hanya mengirim `affCode` (+ `programCode`). **Tambahkan `productCode`.**

### Endpoint

- **`POST /api/affiliate/visits`** — log klik link (auth opsional)
- **`POST /api/affiliate/attribution`** — bind ke member setelah login (wajib Bearer token)

### Field yang diterima

| Field | Wajib | Alias diterima | Catatan |
|---|---|---|---|
| `affiliatorCode` | ya | `affCode`, `aff`, query `?affCode=` | kode affiliator (6 char) |
| `programCode` | `visits`: opsional · `attribution`: wajib | `program_code`, query `?program=` | kode program (8 char) |
| **`productCode`** | **ya (efektif) — tanpa ini tak ada komisi** | **`product_code`, `product`, query `?product=`** | **BARU.** Produk yang dituju link |

### `productCode` formatnya apa?

Backend resolve `productCode` ke produk dengan urutan **legacyId (angka) → `code` → `slug`** — sama persis seperti param di halaman product detail (`/course/detail/<x>`). Kirim **nilai yang sama** yang dipakai app untuk membuka product detail dari OneLink (umumnya `productCode` dari `setAffiliateRedirectProductCode`, atau slug). Kalau tidak ketemu / tidak dikirim → visit tercatat product-less → **tidak menghasilkan komisi** (strict).

### Contoh payload

```jsonc
// POST /api/affiliate/visits
{
  "affiliatorCode": "X7K9Q2",
  "programCode": "AB12CD34",   // opsional di /visits
  "productCode": "CRS123",     // <-- WAJIB kirim (legacyId | code | slug)
  "clientEventId": "uuid-v4"   // idempotency, sangat dianjurkan
}
```

```jsonc
// POST /api/affiliate/attribution  (perlu Bearer token)
{
  "affiliatorCode": "X7K9Q2",
  "programCode": "AB12CD34",   // wajib di /attribution
  "productCode": "CRS123"      // <-- WAJIB kirim
}
```

### Lokasi kode (referensi)

- `affiliate_remote_source.dart:19-20` — `logAttribution(affiliatorCode, programCode)` → tambah `productCode`.
- Ambil productCode dari store yang sama dengan `setAffiliateRedirectProductCode` (`appsflyer_service.dart`).

---

## M-1 — Clear attribute RC setelah dipakai

Backend tidak lagi membaca attribute ini, tapi tetap **dianjurkan dibersihkan** agar tidak ada data sticky yang menyesatkan channel/analytics lain.

```dart
// RevenueCat: set null = hapus attribute
await Purchases.setAttributes({'affiliate_code': null});
```

Lokasi: `lib/app/payment/ios_iap_service.dart` (sekitar blok purchase `:106-110`).

---

## M-2 — Konsistenkan lifecycle affCode

- `dataStore` affCode **dan** attribute RC dibersihkan **bersamaan** setelah dikonsumsi (saat ini hanya `dataStore` yang di-clear — `product_detail_page.dart:270`).
- Set attribusi/log visit **hanya** untuk konteks affiliate valid; jangan set ulang nilai lama untuk pembelian tanpa affiliate.
- **Idealnya** pindahkan pemicu attribusi ke **purchase-time** (bukan view-time `initState`). Pastikan `productCode` selalu ikut.

---

## Perilaku attribusi (STRICT per-produk) — untuk QA

Untuk tiap pembelian Produk **P**, backend memilih affiliator:

1. **visit terakhir (dalam window) yang `productCode` = P** → affiliator itu.
2. kalau tidak ada → **inviter permanen** si buyer.
3. kalau tidak ada → tidak ada komisi affiliate.

Visit **product-less (tanpa productCode)** atau visit untuk **produk lain** → **DIABAIKAN**.

Konsekuensi:
- Klik link Produk X → beli Produk Y (tanpa link Y) → **affiliate X TIDAK dapat komisi Y**. ✅
- Klik link A (X) lalu link B (Y), beli dua-duanya → **A dapat X, B dapat Y**. ✅
- Visit tanpa `productCode` → **tidak ada komisi affiliate** (inviter only). ⚠️ inilah kenapa M-4 wajib.

---

## Acceptance / skenario uji

- [ ] `productCode` terkirim di `POST /affiliate/visits` & `/affiliate/attribution` (cek payload network).
- [ ] Beli via link affiliate (produk yang sama dgn link) → komisi muncul **sekali** untuk affiliate yang benar.
- [ ] Beli produk lain **tanpa** link → **tidak** ada komisi affiliate (kecuali inviter sah).
- [ ] Klik link Produk X, lalu beli Produk Y → komisi Y **tidak** ke pemilik link X.
- [ ] Restore / re-sync / beli-ulang produk yang sama → **tidak** menambah komisi baru.
- [ ] Attribute RC `affiliate_code` di-clear setelah purchase (cek RC dashboard subscriber).

---

## Catatan

- `productCode` secara teknis opsional di DTO (non-breaking), **tapi** karena backend strict, tanpa-nya = tidak ada komisi affiliate. Perlakukan sebagai **wajib**.
- Tidak ada env/secret baru di sisi backend.
- Kontrak API → Swagger `/api/docs` (DTO `LogVisitDto` / `LogAttributionDto` memuat `productCode`).
