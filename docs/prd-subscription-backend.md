# PRD Backend — BrainBoost Subscription (Phase 1: Annual)

> Diturunkan dari "BrainBoost Subscription – Pricing Roadmap v1.0" (COO, 9 Juni 2026).
> Dokumen kembar: `docs/prd-subscription-mobile.md`.
> Status: DRAFT — task belum dikerjakan. Backlog Jira: project **BB**, prefix judul `[BE]`, label `subscription-phase1`.
> Asumsi delivery: **AI-assisted development** (developer memakai coding agent) — estimasi di bawah sudah memperhitungkan itu; review kode + QA tetap manual.

## 1. Konteks & Tujuan

BrainBoost bertransisi dari single-SKU (retail lifetime IDR 298K/judul) ke multi-tier recurring revenue. **Phase 1 (Juli 2026): subscription tahunan** dengan 4 tier akses penuh 54+ protokol:

| Tier | Device/Seat | Harga/tahun | Komisi affiliate (penjualan pertama) |
|---|---|---|---|
| SOLO | 1 | IDR 999.000 | 40% = 399.600 |
| DUO | 2 | IDR 1.499.000 | 40% = 599.600 |
| FAMILY | 4 | IDR 1.999.000 | 40% = 799.600 |
| PREMIUM | 6 | IDR 2.799.000 | 40% = 1.119.600 |

Phase 2 (6 bulan, Q4 2026) dan Phase 3 (bulanan, Q2 2027) **harus zero-code**: hanya menambah row plan baru. Retail lifetime & B2B Team License tidak berubah. B2B2C (Q3 2026) di luar scope dokumen ini (pilot manual, pre-dashboard).

## 2. Keputusan Desain (terkunci)

1. **Seat-based sharing (model Spotify Family):** tier = N seat; owner meng-invite anggota; tiap seat = akun Member sendiri (progress/notifikasi per orang). V1: invite code dibagikan manual oleh owner (tanpa email), di-claim dari app.
2. **Device limit:** tidak ada enforcement baru — login mobile sudah me-revoke sesi mobile lama (1 sesi mobile aktif per akun). N seat × 1 sesi = N device.
3. **Web renewal TANPA auto-charge (v1):** reminder email H-7/H-3/H-1 berisi link repurchase plan yang sama; pembayaran sukses meng-extend expiry. Auto-charge kartu (Xendit PaymentRequest/tokenisasi) = fase berikutnya; kolom `CommercePayment.xenditPaymentMethodId` dkk sudah tersedia.
4. **IAP:** subscription juga dijual sebagai App Store/Play auto-renewing subscription via RevenueCat (webhook sudah ada). RC memegang auto-renew + expiry otoritatif.
5. **Komisi affiliate FLAT, level-1 only** (tanpa tier PERFORMANCE, tanpa upline GROWTH): penjualan pertama 40%; **renewal tetap dapat komisi dengan rate lebih kecil** — angka final belum diputuskan COO → kolom per-plan `renewalAffiliateRate` (placeholder 20%, editable runtime).
6. **Upgrade claim:** buyer dengan total pembelian historis > IDR 2.000.000 dapat di-GRANT 1 tahun Solo gratis (script admin, `source='granted'`, tanpa transaksi).
7. Beli tier berbeda saat masih ACTIVE → tolak 400 (upgrade/proration = Phase 2). Repurchase plan sama = extension.
8. Harga tinggal di `Product.price` (plan 1:1 dengan Product `type='subscription'`) — checkout, voucher, dan verifikasi paid-amount Xendit memakai jalur commerce existing tanpa perubahan.

## 3. Arsitektur Ringkas

- **Data:** `subscription_plans` (1:1 Product) · `member_subscriptions` (owner, status ACTIVE/EXPIRED/CANCELED, expiresAt, graceUntil, canceledAt=cancel-intent, source, providerRef) · `subscription_seats` (pre-provisioned N row, seat 1 = owner, claim = conditional update) · `subscription_activations` (ledger idempotensi per transactionId + audit) · `subscription_reminder_logs` (dedupe reminder). Kolom baru `course_enrollment.via_subscription_id` (marker lazy enrollment).
- **Entitlement:** member entitled ⇔ memegang seat pada sub ACTIVE dengan `coalesce(graceUntil, expiresAt) > now`. Gate media: enrollment valid ATAU subscription aktif → **lazy enrollment** (`expiredDate = sub.expiresAt`) supaya tracker/challenge/progress jalan tanpa perubahan. Row retail (`via_subscription_id` NULL) tidak pernah disentuh kode subscription.
- **Aktivasi:** listener pada `commerce.payment.success` (Xendit + RevenueCat + ingest berkonvergensi di event ini). Semua perubahan expiry lewat ledger (redelivery webhook → P2002 → no-op).
- **Config runtime:** `app_settings`: `subscription.graceDays` (7), `subscription.reminderDaysBefore` ("7,3,1").

## 4. Task Breakdown

> Estimasi (AI-assisted): S ≤ 2 jam · M ≤ ½ hari · L ≤ 1 hari. Urutan ≈ dependency.

| ID | Task | Deskripsi / DoD | Est | Depends |
|---|---|---|---|---|
| BE-01 | Schema & migration subscription | 5 tabel baru + kolom `via_subscription_id`; partial unique: 1 sub ACTIVE/owner, 1 seat/member, unique transactionId di ledger. DoD: migrate bersih, `prisma migrate diff` no drift. | M | — |
| BE-02 | Seed plans + settings | 4 Product (`type='subscription'`, SKU iOS/Android placeholder) + 4 plan + 2 setting baru; script pnpm idempotent (tidak overwrite nilai operator). | S | BE-01 |
| BE-03 | SubscriptionService: aktivasi & renewal | `activateFromPayment` transaksional: create sub + pre-provision seat + owner claim seat 1; renewal = `expiresAt + periodMonths` (anchor ke expiry lama — grace bukan bonus waktu; amandemen 2026-07-10, lihat komentar BB-79; atau expiry RC); idempoten via ledger; bump `expiredDate` lazy enrollment saat renewal. | L | BE-01 |
| BE-04 | SubscriptionService: grant | `grant(memberId, planCode, months?)` source `granted`, ledger kind `grant` tanpa transactionId; extend jika plan sama, tolak jika beda. | S | BE-03 |
| BE-05 | Seat management | `generateInvite` (rotasi kode, crypto-random) / `claimSeat` (conditional update, single-use, P2002 → "sudah punya seat") / `removeSeat` / `leaveSeat` (bebaskan slot + matikan lazy enrollment member itu). | M | BE-03 |
| BE-06 | EntitlementService + lazy enrollment | `hasActiveSubscription` / `getActiveSubscriptionForMember` / `assertCourseAccess` (enrollment valid ATAU sub aktif → lazy-create/refresh row; row retail tidak disentuh). Predikat validitas: retail selalu valid; row sub hanya selama `expiredDate` di masa depan. | M | BE-01 |
| BE-07 | Event bus subscription | `subscription.activated/renewed/expired/canceled` (TypedEmitter, pola `commerce-events`); emit setelah commit; wiring `registerDomainListeners`. | S | BE-03 |
| BE-08 | Listener aktivasi commerce | Pada `commerce.payment.success`: kalau product punya plan → aktivasi (source dari channel, providerRef/expiry dari payload RC). Pada `commerce.payment.refunded`: revoke via ledger transactionId. | S | BE-03, BE-07 |
| BE-09 | Komisi flat subscription | Short-circuit di `commitCommissionsForPayment`: 1 row L1, `schemaType='FLAT'`, rate = `affiliateRate` (initial) / `renewalAffiliateRate` (renewal). Deteksi renewal: flag RC `isRenewal` ATAU ledger (activation lain dengan transactionId beda). Produk retail tidak berubah. | M | BE-03 |
| BE-10 | Gate media subscription-aware | `MediaService.assertEnrollment` → delegasi `assertCourseAccess`. Preview tetap bebas. | S | BE-06 |
| BE-11 | Product list/detail subscription-aware | `isPurchase`/`isPurchased` OR sub aktif; `ownership=purchased` subscriber = semua produk course-backed; `not_purchased` menyaring enrollment tidak valid (typed + raw SQL); exclude `type='subscription'` dari list course default. | M | BE-06 |
| BE-12 | RC webhook: subscription events | DTO + `expiration_at_ms`, `cancel_reason`; event `EXPIRATION` → expire sub by providerRef; `CANCELLATION` branching: `UNSUBSCRIBE`/billing → cancel-intent (akses lanjut), refund (`CUSTOMER_SUPPORT`) → jalur refund existing. | M | BE-03 |
| BE-13 | purchase-ingest: subscription facts | Fix resolve SKU: `iosProductId` ATAU `androidProductId`; teruskan `expirationAtMs`/`providerRef` ke event; `attributionKey` per-periode (transaction_id) khusus produk subscription supaya renewal RC bayar komisi sekali per periode. | M | BE-09 |
| BE-14 | Guard checkout | Tolak 400: beli plan beda saat ACTIVE; beli plan saat memegang seat di sub orang lain. Plan sama = boleh (renewal-by-repurchase). Voucher: no change (sudah product-agnostic). | S | BE-01 |
| BE-15 | Job renewal reminder | Bucket H-7/3/1 dari setting; dedupe insert-first di `subscription_reminder_logs` (re-arm otomatis setelah renewal); enqueue email `SubscriptionRenewalReminder` (outbox → bb-comms) + push notif. Daftarkan di jobs-runner. | M | BE-03 |
| BE-16 | Job expire subscriptions | `ACTIVE AND coalesce(graceUntil, expiresAt) < now` → EXPIRED + emit event. Lazy enrollment mati sendiri via `expiredDate`. | S | BE-07 |
| BE-17 | Notification listeners | Notif in-app/push untuk activated/renewed/expired/canceled (label `subscriptionRenewed` sudah ada; tambah label baru). | S | BE-07 |
| BE-18 | Email receipt + template bb-comms | Listener email `SubscriptionActivated`/`SubscriptionRenewed`. **Dependensi eksternal: 3 template baru di repo bb-comms** (reminder + 2 receipt, render by refId). | S | BE-07, eksternal |
| BE-19 | Modul HTTP `/subscription` | `GET /plans` (public), `GET /me`, `POST /seats/invite`, `POST /seats/claim`, `DELETE /seats/:id`, `POST /seats/leave`, `POST /cancel` (IAP → pesan "atur di store"). Pola `bindRoute` + DTO + envelope standar. | M | BE-05, BE-06 |
| BE-20 | Script grant + eligibility | `scripts/grant-subscription.ts`: `--email/--member-id/--plan/--dry-run`, `--list-eligible` (SUM amount PAID > 2jt), `--grant-eligible` batch (skip yang sudah punya sub/seat). | S | BE-04 |
| BE-21 | Integration tests | Suite: activation (idempoten, extension math), RC (expiry/EXPIRATION/cancel_reason/SKU android/komisi renewal), seats (claim/limit/race), entitlement-media (lazy enrollment, lapsed 403, retail utuh), flat-commission, jobs (dedupe reminder, expire). Postgres asli, tanpa mock DB. | L | semua |
| BE-22 | Docs + reporting | `docs/subscription-port.md` (aturan bisnis + edge case), update CLAUDE.md §5 + rewrite-progress; query reporting subscriber per tier terdokumentasi. | S | semua |

**Total estimasi kasar:** ~6–8 hari-orang (AI-assisted; tanpa AI ~12–15).

## 5. Dependensi Eksternal (di luar repo ini)

1. **bb-comms:** template `SubscriptionRenewalReminder`, `SubscriptionActivated`, `SubscriptionRenewed`.
2. **App Store / Play Store:** buat produk auto-renewing subscription 4 tier (annual) + isi SKU asli ke Product (`iosProductId`/`androidProductId`) + konfigurasi entitlement/offering RevenueCat.
3. **Keputusan COO:** angka final `renewalAffiliateRate` (placeholder 20%).
4. **Marketing:** copy email reminder + landing page (link repurchase).

## 6. Out of Scope (v1)

- Auto-charge kartu web (Xendit PaymentRequest + tokenisasi).
- Upgrade/proration antar tier & funnel 6-bulan→annual (Phase 2).
- B2B2C mass market (partner org, bulk provisioning, activation dashboard) — pilot Q3 manual.
- Dashboard reporting (cukup query SQL).

## 7. Risiko

- **Timeline:** roadmap menargetkan infrastruktur live sebelum launch Juli — sudah lewat; konfirmasi tanggal launch aktual ke COO.
- Template bb-comms belum ada → job reminder jangan diaktifkan di prod sebelum template siap (outbox row akan gagal di bb-comms).
- Enrollment hasil migrasi legacy punya `expired_date` terisi — gate baru TIDAK boleh menghormati kolom itu untuk row retail (hanya row subscription), kalau tidak buyer lifetime lama bisa kehilangan akses.
- Renewal web = repurchase manual → ekspektasi churn lebih tinggi dibanding auto-charge; ukur di Day-30 report.
