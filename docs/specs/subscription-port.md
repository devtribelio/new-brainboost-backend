# Subscription (Phase 1: Annual) — Business Rules & Ops

> Implementasi PRD `docs/specs/prd-subscription-backend.md` (BE-01…BE-22, Jira BB-77…BB-98,
> branch `feat/subscription`). Progres & log keputusan: `docs/specs/subscription-progress.md`.
> Dokumen ini = aturan bisnis yang MENGIKAT + edge case + runbook operasional + query reporting.

## 1. Model ringkas

4 tier annual (SOLO 1 seat 999K · DUO 2 1.499K · FAMILY 4 1.999K · PREMIUM 6 2.799K),
akses penuh semua course. Plan = row `subscription_plans` **1:1 dengan `Product`
`type='subscription'`** — harga tinggal di `products.price` sehingga checkout, voucher,
dan verifikasi paid-amount Xendit memakai jalur commerce existing tanpa perubahan.
Phase 2 (6 bulan) / Phase 3 (bulanan) = **tambah row plan baru, zero-code**.

Dua jalur beli yang berkonvergensi di event `commerce.payment.success`:
- **Web (Xendit):** checkout commerce biasa; renewal = repurchase manual (tanpa auto-charge di v1).
- **IAP (RevenueCat):** auto-renewing subscription; RC otoritatif untuk auto-renew + expiry.

## 2. Data

| Tabel | Peran |
|---|---|
| `subscription_plans` | Definisi tier (1:1 product): code, tier, periodMonths, seatCount, `affiliate_rate` (40), `renewal_affiliate_rate` (20, placeholder COO — editable runtime) |
| `member_subscriptions` | Sub per owner: status `ACTIVE\|EXPIRED\|CANCELED`, `expires_at`, `grace_until`, `canceled_at` (= cancel-INTENT), `source` (`xendit\|revenuecat\|granted`), `provider_ref` (RC original_transaction_id), `latest_transaction_id` |
| `subscription_seats` | Slot pre-provisioned (seat 1 = owner); `invite_code` unique single-use |
| `subscription_activations` | Ledger append-only tiap perubahan expiry: `kind` `initial\|renewal\|plan_change\|grant` — kunci idempotensi + audit + deteksi renewal + guard kampanye grant |
| `subscription_reminder_logs` | Dedupe job reminder, unique `(subscription_id, expires_at, days_before)` |
| `course_enrollment.via_subscription_id` | Marker lazy enrollment (NULL = retail/legacy) |

**3 partial unique index** (SQL manual di migration `20260707140000_add_subscription`;
Prisma 5.22 mengabaikannya saat diff — no drift):
`uniq_active_sub_per_owner (owner_id) WHERE status='ACTIVE'` ·
`uniq_active_seat_per_member (member_id) WHERE member_id IS NOT NULL` ·
`uniq_activation_tx (transaction_id) WHERE transaction_id IS NOT NULL`.
⚠️ Prisma melaporkan pelanggarannya dengan **nama kolom** (P2002 `meta.target=['transaction_id']`),
bukan nama constraint — matcher idempotensi di `subscription.service.ts` mencocokkan kolom.

## 3. Aturan bisnis (mengikat)

1. **Entitled** ⇔ member **memegang seat** (owner = seat 1) pada sub `status='ACTIVE'`
   dengan `coalesce(grace_until, expires_at) > now`. Grace default 7 hari
   (`app_settings subscription.graceDays`, runtime).
2. **Validitas enrollment (aturan sakral):** row retail/legacy (`via_subscription_id`
   NULL) **selalu valid by existence** — `expired_date` hasil migrasi legacy DIABAIKAN
   (menghormatinya = buyer lifetime lama kehilangan akses). Row lazy hanya valid selama
   `expired_date > now`. Ekspresi ini ada di `EntitlementService.isEnrollmentValid` dan
   HARUS di-mirror oleh setiap filter SQL (lihat `validEnrollmentWhere` di product.service).
3. **Lazy enrollment:** dibuat/di-refresh saat subscriber mengakses course
   (`assertCourseAccess`), `expired_date` = expiry sub; di-bump saat renewal/plan-change;
   di-nol-kan saat remove/leave seat & refund; mati sendiri saat expiry (tanpa cleanup job).
   Beli retail di atas row lazy → marker dibersihkan (**upgrade lifetime**, di
   `grantCourseEnrollment`).
4. **Idempotensi aktivasi:** insert ledger ber-`transaction_id` adalah **write TERAKHIR**
   dalam transaksi `activateFromPayment` — redelivery webhook → P2002 → seluruh tx
   rollback → no-op. Expiry tidak pernah dobel-extend. Race initial paralel → yang kalah
   retry sekali dan jatuh ke cabang renewal (kedua pembayaran dihormati).
5. **Renewal math (amandemen BB-79, 2026-07-10):** `newExpiry = providerExpiresAt ??
   expiresAt + periodMonths` — anchor SELALU ke expiry lama, termasuk perpanjangan
   saat grace (expired 9 Jul, bayar 10 Jul → 9 Jul tahun depan). **Grace = napas
   untuk membayar, bukan bonus waktu.** Perpanjang lebih awal menumpuk di atas sisa
   masa aktif; lewat grace = sub BARU berbasis tanggal beli (aturan #6). Expiry
   provider (RC `expiration_at_ms`) SELALU menang. Renewal juga meng-clear
   `canceled_at` (repurchase = batal niat cancel).
6. **Repurchase setelah EXPIRED = sub BARU** (bukan extend); sub lama tinggal sebagai
   arsip. Seat zombie (di sub mati) dilepas on-demand saat member itu beli/claim lagi.
7. **Plan change hanya via RC `PRODUCT_CHANGE`.** Web: beli plan beda saat ACTIVE →
   400 (guard `CheckoutService.start`); plan sama = renewal-by-repurchase (jalur reminder).
   Juga 400: beli plan saat memegang seat di sub ACTIVE orang lain.
8. **Cancel:** `POST /subscription/cancel` (web) & RC CANCELLATION `UNSUBSCRIBE`/
   `BILLING_ERROR` = **cancel-intent** — `canceled_at` terisi, akses jalan sampai expiry.
   Sub RC di-cancel dari web → 400 "kelola di store". **Refund** (Xendit refund / RC
   `CUSTOMER_SUPPORT` / CANCELLATION tanpa reason — kompatibilitas payload lama & retail)
   = satu-satunya pemutus akses seketika: sub CANCELED + lazy enrollment mati + komisi
   VOIDED (jalur refund commerce existing).
9. **RC EXPIRATION** → `expireByProviderRef`: flip EXPIRED (+ tarik expiry/lazy ke now
   bila masih masa depan). Webhook hanya nyambung via `provider_ref` = `original_transaction_id`.
10. **Komisi flat (short-circuit di `commitCommissionsForPayment`):** produk ber-plan →
    **1 row level-1** ke seed (link override ?? inviter), `schemaType='FLAT'`, rate dari
    plan: 40% penjualan pertama / `renewal_affiliate_rate` untuk renewal. Deteksi renewal =
    flag RC `isRenewal` OR ada aktivasi lain ber-`transaction_id` non-NULL di ledger
    (independen urutan listener; **grant tidak dihitung** — pembayaran pertama pasca-grant
    = penjualan pertama). `attributionKey` produk plan = `transaction_id` RC (per periode)
    supaya tiap renewal bayar komisi tepat 1×; retail tetap `original_transaction_id`.
    Produk retail: skema PERFORMANCE/GROWTH legacy tidak berubah.
11. **Seats:** invite = kode 10 char (alfabet tanpa 0/O/1/I), rotasi per panggil, ditulis
    di slot kosong pertama; claim = conditional UPDATE satu statement (race: tepat satu
    pemenang; kode single-use ter-NULL di statement yang sama); 1 member = 1 seat lintas
    semua sub (DB-enforced); owner tidak bisa claim/leave; remove/leave membebaskan slot +
    memutus akses lazy member itu seketika.
12. **Grant (`SubscriptionService.grant`):** `source='granted'`, ledger `kind='grant'`
    `transaction_id` NULL; plan sama → extend, beda → tolak; TANPA komisi & tanpa
    transaksi. Kampanye batch (`pnpm grant:subscription --grant-eligible`): guard
    **ledger `kind='grant'` sekali seumur kampanye** (tahan sub expired) + skip sub
    ACTIVE / seat aktif. Grant satuan `--email` = alat CS, boleh extend (pakai `--dry-run`).
13. **Eligibility kampanye >2jt = DUA sumber:** `commerce_transactions` PAID (platform
    baru) **+ query langsung legacy MariaDB** (`course_payment` + `product_bundle_payment`
    SUCCESS, scoped brainboost, belanja = `GREATEST(amount − amount_voucher, 0)` —
    `payment_amount` sering NULL, JANGAN dipakai), map via `members.legacy_id` +
    `member_redirect`. Tanpa `LEGACY_DB_*` mode ini menolak jalan. Hanya hidup selama
    masa transisi. Temuan smoke 2026-07-08: 46.070 paying member legacy → 179 eligible;
    **655 paying member legacy tanpa akun baru** (investigasi migrasi terpisah).
14. **Events (`subscription-events.ts`):** `activated`/`renewed`/`expired`/`canceled`
    (reason `user|store|refund`), di-emit SETELAH commit oleh caller (listener commerce,
    webhook RC, job expire, endpoint cancel, script grant). Notif in-app: 4 label
    (`subscriptionActivated/Renewed/Expired/Canceled`); `canceled(refund)` diam (notif
    refund commerce sudah cover). Email outbox: `SubscriptionActivated`/`SubscriptionRenewed`
    (refId = subscriptionId). **Anti-dobel:** listener notif & email commerce SKIP produk
    ber-plan — pesan subscription sepenuhnya milik listener subscription.
15. **Jobs (jobs-runner, urutan penting):** `subscriptionExpire` SEBELUM
    `subscriptionRenewalReminder` (sub mati tidak boleh dapat reminder di tick yang sama).
    Reminder: bucket dari `subscription.reminderDaysBefore` ("7,3,1"), diproses TERKECIL
    dulu; kirim hanya bila belum ada log `(sub, expiresAt, daysBefore ≤ D)` — suppression
    **ter-scope per siklus expiry** (renewal otomatis re-arm); claim log DULU baru kirim
    (at-most-once; gagal-setelah-claim TIDAK di-retry — bucket berikutnya adalah tangga
    retry alaminya).

## 4. Peta test (15 spec, `apps/mobile-api/tests/subscription/`)

| Spec | Aturan |
|---|---|
| `activation.spec` | #4 #5 idempotensi, extension math, provider expiry, plan change seat |
| `edge-cases.spec` | #4 race konkuren, #6, voucher-bypass 100%, in-grace, invite penuh |
| `grant.spec` / `grant-script.spec` | #12 #13 |
| `seats.spec` | #11 |
| `entitlement.spec` / `product-subscription.spec` | #1 #2 #3 + surface product/media |
| `flat-commission.spec` | #10 |
| `rc-subscription.spec` | #5 #8 #9 #10 (SKU android, per-period attributionKey) |
| `activation-listener.spec` / `subscription-email.spec` / `jobs.spec` | #14 #15 |
| `subscription-http.spec` / `checkout-guard.spec` | #7 #8 + modul HTTP |
| `seed-plans.spec` | seed idempoten |

## 5. Runbook launch (urutan!)

1. Deploy backend (semua BE-01…BE-21 satu deploy — surface product sudah
   subscription-aware sebelum plan di-seed).
2. **bb-comms**: ship 3 template (`SubscriptionRenewalReminder`, `SubscriptionActivated`,
   `SubscriptionRenewed`, render by refId `member_subscriptions.id`) — SEBELUM jobs
   dijadwalkan di prod.
3. Store: buat produk auto-renewing 4 tier di App Store/Play + entitlement RevenueCat →
   UPDATE `products.ios_product_id`/`android_product_id` (seed = placeholder
   `com.brainboost.{ios,android}.sub_*_annual`).
4. `pnpm seed:subscription-plans && pnpm seed:settings` di prod (idempoten, tidak
   menimpa nilai operator).
5. Set `renewal_affiliate_rate` final begitu COO memutuskan (UPDATE `subscription_plans`).
6. Jadwalkan jobs-runner (sudah berisi `subscriptionExpire` + `subscriptionRenewalReminder`).
7. Kampanye grant: `pnpm grant:subscription --list-eligible` (butuh `LEGACY_DB_*`) →
   spot-check angka vs legacy → approve marketing → `--grant-eligible --dry-run` → eksekusi.

## 6. Query reporting (SQL, read-only)

```sql
-- Subscriber aktif per tier (entitled window)
SELECT p.tier, COUNT(*) AS subscribers
FROM member_subscriptions ms JOIN subscription_plans p ON p.id = ms.plan_id
WHERE ms.status = 'ACTIVE' AND COALESCE(ms.grace_until, ms.expires_at) > now()
GROUP BY p.tier ORDER BY MIN(p.sort_order);

-- Tier mix + run-rate revenue tahunan (harga web)
SELECT p.tier, COUNT(*) AS subs, COUNT(*) * pr.price AS annual_run_rate_idr
FROM member_subscriptions ms
JOIN subscription_plans p ON p.id = ms.plan_id
JOIN products pr ON pr.id = p.product_id
WHERE ms.status = 'ACTIVE' AND COALESCE(ms.grace_until, ms.expires_at) > now()
GROUP BY p.tier, pr.price ORDER BY MIN(p.sort_order);

-- Mix source (web/IAP/granted) + cancel-intent rate per tier
SELECT p.tier, ms.source, COUNT(*) AS subs,
       COUNT(*) FILTER (WHERE ms.canceled_at IS NOT NULL) AS cancel_intent
FROM member_subscriptions ms JOIN subscription_plans p ON p.id = ms.plan_id
WHERE ms.status = 'ACTIVE'
GROUP BY p.tier, ms.source ORDER BY MIN(p.sort_order), ms.source;

-- Upgrade rate dari retail buyer: subscriber yang punya enrollment retail
-- LEBIH TUA dari sub pertamanya (retail → subscription conversion)
SELECT COUNT(*) FILTER (WHERE upgraded) AS from_retail, COUNT(*) AS total_owners,
       ROUND(100.0 * COUNT(*) FILTER (WHERE upgraded) / NULLIF(COUNT(*),0), 1) AS pct
FROM (
  SELECT ms.owner_id, EXISTS (
    SELECT 1 FROM course_enrollment ce
    WHERE ce.member_id = ms.owner_id AND ce.via_subscription_id IS NULL
      AND ce.created_at < ms.created_at
  ) AS upgraded
  FROM member_subscriptions ms
  WHERE ms.status = 'ACTIVE'
) t;

-- Aktivitas per bulan dari ledger (initial vs renewal vs grant) — bahan Day-30 churn
SELECT date_trunc('month', sa.created_at) AS month, sa.kind, COUNT(*)
FROM subscription_activations sa
GROUP BY 1, 2 ORDER BY 1, 2;

-- Okupansi seat (utilisasi sharing per tier)
SELECT p.tier, COUNT(ss.id) AS seats, COUNT(ss.member_id) AS claimed,
       ROUND(100.0 * COUNT(ss.member_id) / NULLIF(COUNT(ss.id),0), 1) AS occupancy_pct
FROM subscription_seats ss
JOIN member_subscriptions ms ON ms.id = ss.subscription_id
JOIN subscription_plans p ON p.id = ms.plan_id
WHERE ms.status = 'ACTIVE'
GROUP BY p.tier ORDER BY MIN(p.sort_order);
```

## 7. Dependensi eksternal yang masih menggantung

| Apa | Pemilik | Status |
|---|---|---|
| 3 template email di bb-comms | tim bb-comms | ❌ belum — blocker jobs reminder & receipt di prod |
| SKU asli App Store/Play + entitlement RC | mobile/ops | ❌ placeholder di DB |
| Angka final `renewal_affiliate_rate` | COO | ❌ placeholder 20% |
| Copy email reminder + landing repurchase | marketing | ❌ |
| Investigasi 655 legacy paying member tanpa akun baru | backend | ❌ temuan BE-20 |
