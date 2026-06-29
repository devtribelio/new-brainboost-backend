# Affiliate Over-Attribution (IAP) — Root Cause & Fix Plan

**Status:** backend B-1/B-2/B-3 implemented in code (migration apply + data cleanup + app M-1/M-2 pending)
**Severity:** High (affiliate dibayar untuk pembelian yang bukan hasil referral mereka)
**Repos:** `brainboost-apps` (Flutter) + `new-brainboost-backend`

---

## Implementation status (backend, this repo)

| Bagian | Status | Catatan |
|---|---|---|
| **B-1** attribute hanya di pembelian awal | ✅ via B-3 | `revenuecat.handler.ts::toPurchase` tidak lagi membaca `affiliate_code` sama sekali (lihat B-3), jadi RENEWAL/PRODUCT_CHANGE/restore tak pernah meng-attribute. |
| **B-2** idempotensi `original_transaction_id` | ✅ kode | Tabel baru `AffiliateAttributionClaim` `@@unique([provider, attributionKey])`. Ingest klaim 1× per purchase; re-settle (delete+rebuy/renewal/restore/burst) dapat enrollment tapi **tidak** bayar komisi. Race-proof via unique insert. `attributionKey = original_transaction_id ?? transaction_id`. |
| **B-3** andalkan VISIT, buang sticky attribute | ✅ kode | Handler set `affiliatorCode: undefined`; attribusi murni dari `AffiliateVisit` (self-expiring, last-touch) → inviter. Menutup kasus "beli produk lain tanpa affiliate". |
| **B-4** guard tambahan (timestamp/cutoff) | ⏭️ skip | Tidak diperlukan setelah B-2+B-3. |
| Migration apply (`prisma migrate deploy`) | ⏳ file siap, apply pending | Migration `prisma/migrations/20260629120000_add_affiliate_attribution_claim/` (additive: kolom `commerce_transactions.attribution_key` + tabel `affiliate_attribution_claims`). Belum di-apply ke DB. Re-copy `schema.prisma` ke `bb-legacy-resync` setelah apply. |
| Data cleanup (VOID komisi nyasar) | ⏳ script siap, run pending | `pnpm void:stray-affiliate-commissions` (DRY-RUN default; `--apply` untuk void). Conservative: hanya void grup `PENDING` channel `revenuecat` yang TANPA inviter-ancestor sah DAN tanpa `AffiliateVisit` buyer→affiliator. Jalankan sebelum job `pending-to-balance`. Lihat section DATA CLEANUP. |
| App M-1/M-2 (clear attribute RC) | ⏳ pending | Repo `brainboost-apps`. Tetap dianjurkan walau backend kini tak baca attribute. |

Tes: `tests/ingest/attribution-claim.spec.ts` (first-settle-wins; butuh test Postgres). Typecheck repo hijau.

---

## Ringkasan

Pembelian via IAP (RevenueCat) ter-attribute ke affiliate **berkali-kali / pada pembelian yang tidak melalui affiliate**. Pada satu kasus uji, 1 user dapat **3 komisi** untuk affiliate yang sama padahal 2 dari 3 pembelian tidak pakai affiliate, dan buyer **tidak punya inviter**.

**Akar masalah utama:** `affiliate_code` disimpan sebagai **RevenueCat subscriber attribute** yang **sticky (tidak pernah di-clear)** → ikut terkirim di **setiap** event RC berikutnya (renewal, pembelian baru, restore, re-sync/replay). Backend membaca attribute ini di tiap event → meng-attribute semuanya ke affiliate yang sama.

---

## Cara reproduksi (kasus yang ditemukan)

1. User beli 1 produk via link affiliate → app set `affiliate_code` di RC (menempel permanen di subscriber).
2. (Test) Hapus transaksi di dashboard RevenueCat, lalu beli ulang.
3. RC melakukan **re-sync → burst 3 event** (2 lama + 1 baru).
4. Tiap event membawa `subscriber_attributes.affiliate_code` yang menempel → ketiganya ter-attribute ke affiliate tsb.
5. Karena delete+rebuy menghasilkan `transaction_id` baru → `paymentId` baru → idempotensi komisi tidak menganggapnya duplikat → **3 komisi dibuat**.

> Buyer inviter kosong & self-referral sudah dijaga — jadi 3 komisi itu murni dari `affiliate_code` yang menempel.

---

## Kenapa ini bug PRODUKSI (bukan sekadar artefak test)

Tanpa hapus-transaksi sekalipun: user yang **sekali** beli via affiliate, lalu **beli produk lain tanpa affiliate**, pembelian kedua **tetap** membawa `affiliate_code` lama (masih menempel di subscriber) → ter-attribute ke affiliate lama. Affiliate terus dibayar untuk pembelian yang bukan referral mereka.

---

## Alur kode (referensi)

| Lapis | Lokasi | Perilaku |
|---|---|---|
| App set attribute | `lib/app/payment/ios_iap_service.dart:60` | `Purchases.setAttributes({'affiliate_code': code})` — sticky di subscriber |
| App panggil sebelum beli | `lib/app/payment/ios_iap_service.dart:106-109` | set affCode (kalau ada di dataStore) lalu `Purchases.purchase(...)` |
| App clear (tidak lengkap) | `lib/app/product/product_detail/pages/product_detail_page.dart:270` | hanya clear `dataStore` lokal — **bukan** attribute RC |
| Backend baca attribute | `new-brainboost-backend` `apps/mobile-api/src/modules/webhook/revenuecat.handler.ts` (`toPurchase`) | `affiliatorCode = event.subscriber_attributes.affiliate_code` dibaca di **tiap** event; `providerEventId = event.transaction_id ?? event.id` |
| Backend idempotensi ingest | `.../modules/ingest/purchase-ingest.service.ts` | unik `(provider, providerEventId)` — gagal mengenali kalau `transaction_id` berubah (delete+rebuy / re-sync) |
| Backend resolusi affiliate | `packages/domain/src/affiliate/attribution.service.ts` | (1) explicit code → member; (2) `AffiliateVisit` dalam window `affiliate.cookieDays`; (3) null → inviter |
| Backend buat komisi | `packages/domain/src/affiliate/affiliator.service.ts:212` | dedup unik `(paymentId, recipientId, level)` (`:242`); self-referral guard (`:189`); status awal `PENDING` (`:228`) |

---

## MOBILE (Flutter — `brainboost-apps`)

Tujuan: `affiliate_code` hanya berlaku untuk pembelian yang benar-benar berasal dari link affiliate, tidak menempel ke pembelian lain.

### M-1. Clear attribute RC setelah dipakai *(prioritas, kecil)*
Setelah purchase selesai (atau tepat setelah `setAffiliateCode` + `purchase`), kosongkan attribute agar tidak bocor ke pembelian berikutnya:
```dart
// RevenueCat: set null = hapus attribute
await Purchases.setAttributes({'affiliate_code': null});
```
Lokasi: `lib/app/payment/ios_iap_service.dart` (sekitar blok purchase `:106-110`).

### M-2. Konsistenkan lifecycle affCode
- Pastikan `dataStore` affCode dan attribute RC **dibersihkan bersamaan** setelah dikonsumsi (saat ini hanya `dataStore` yang di-clear — `product_detail_page.dart:270`).
- Set `affiliate_code` **hanya** untuk pembelian yang affCode-nya valid & relevan; jangan set ulang nilai lama untuk pembelian tanpa affiliate.

### M-3. Catatan
Membersihkan attribute saja **tidak cukup** (event yang sudah ter-queue / di-replay RC bisa tetap membawa nilai lama). Perbaikan backend (B-1/B-2) tetap wajib sebagai sumber kebenaran.

---

## BACKEND (`new-brainboost-backend`)

Tujuan: attribusi tahan terhadap replay/renewal/re-sync; tidak bergantung pada subscriber attribute yang sticky.

### B-1. Attribute affiliate HANYA pada pembelian awal *(prioritas)*
`revenuecat.handler.ts` (`toPurchase`): hanya isi `affiliatorCode` untuk event pembelian **pertama** dari sebuah `original_transaction_id`. Abaikan `affiliate_code` pada:
- `RENEWAL`, `PRODUCT_CHANGE`, `TRANSFER`
- restore / re-sync (event yang `original_transaction_id`-nya sudah pernah punya transaksi tersettle)

> Implementasi: diambil pendekatan lebih kuat (B-3) — handler **tidak membaca** `affiliate_code` sama sekali, jadi B-1 otomatis terpenuhi.

### B-2. Idempotensi berbasis `original_transaction_id`
`purchase-ingest.service.ts`: jadikan `original_transaction_id` bagian dari kunci idempotensi (bukan hanya `transaction_id`). Jika sudah ada transaksi tersettle untuk `original_transaction_id` itu → perlakukan event baru sebagai duplikat untuk tujuan komisi (jangan buat `paymentId`/komisi baru).

> Implementasi: tabel `affiliate_attribution_claims` `@@unique([provider, attribution_key])`. Ingest meng-klaim sekali per `(provider, attributionKey)`; settle pertama bayar komisi, sisanya enrollment-only. Race-proof terhadap burst.

### B-3. Andalkan attribusi berbasis VISIT (sudah punya expiry)
`attribution.service.ts` sudah punya jalur `AffiliateVisit` dengan window `affiliate.cookieDays` (self-expiring, last-touch) — itu model attribusi yang benar. Prioritaskan jalur visit dibanding subscriber attribute yang sticky. Subscriber attribute tidak punya expiry → tidak cocok sebagai sumber attribusi.

> Implementasi: handler RC set `affiliatorCode: undefined` → attribusi 100% via visit → inviter.

### B-4. (Opsional) Guard tambahan
Pertimbangkan menolak attribusi komisi untuk event RC yang lebih tua dari cutoff tertentu, atau yang teridentifikasi sebagai restore/re-sync. *(Skip — tidak diperlukan setelah B-2+B-3.)*

---

## DATA CLEANUP

Komisi yang sudah terlanjur salah saat ini berstatus `PENDING` (belum dibayar). Sebelum proses payout:
- **VOID** komisi yang nyasar (set `status = VOIDED`, isi `voidedReason`), khususnya yang tidak punya jejak affiliate/visit yang sah pada pembelian aslinya.
- Lakukan sebelum job `affiliate-pending-to-balance` memindahkan PENDING → BALANCE.

Script: `pnpm void:stray-affiliate-commissions` (DRY-RUN) → review → `--apply`. Conservative: hanya void grup yang tanpa inviter-ancestor sah DAN tanpa `AffiliateVisit` buyer→affiliator.

---

## Verifikasi / Acceptance

- [ ] Beli via affiliate → komisi muncul **sekali** untuk affiliate yang benar.
- [ ] Beli produk lain **tanpa** affiliate (subscriber yang sama) → **tidak** ada komisi affiliate (kecuali ada inviter sah).
- [ ] Re-sync / replay event RC untuk transaksi yang sama → **tidak** menambah komisi baru (idempotensi `original_transaction_id`).
- [ ] Renewal/restore → tidak membuat attribusi affiliate baru.
- [ ] 3 komisi nyasar pada kasus uji sudah di-VOID.
