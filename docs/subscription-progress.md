# Subscription Phase 1 — Progress Tracker

> Sumber kebenaran progres implementasi PRD `docs/prd-subscription-backend.md`.
> **Cara resume sesi baru:** prompt — *"baca docs/prd-subscription-backend.md + docs/subscription-progress.md, lanjut task berikutnya yang belum selesai"*.
> **Aturan update (WAJIB tiap akhir sesi / selesai task):** update baris task di tabel (status, branch, catatan) dan catat keputusan/penemuan non-obvious di bagian "Log keputusan".
> **Aturan status Jira (revisi 2026-07-08):** mulai task → flip ke **Development**; user bilang commit → git commit + flip ke **Done** (satu langkah). Doneness juga dicatat di tabel tracker ini.

- Branch kerja: `feat/subscription` (dari `main`) — satu branch untuk seluruh phase 1, PR per kelompok task jika perlu.
- Jira: project BB, label `subscription-phase1`, assignee Warda June.

## Status task

Status: `todo` → `wip` → `done` (done = kode + test hijau; ✅ di kolom Jira = sudah ditransisikan).

| Task | Jira | Status | Catatan |
|---|---|---|---|
| BE-01 Schema & migration | BB-77 | **selesai — menunggu review** | migration `20260707140000_add_subscription`; 5 tabel + enum + `via_subscription_id` + 3 partial unique; 470/470 test hijau |
| BE-02 Seed plans + settings | BB-78 | **selesai — menunggu review** | `pnpm seed:subscription-plans` (+--dry-run); create-only, tidak overwrite operator; SKU placeholder `com.brainboost.{ios,android}.sub_*_annual`; ⚠️ JANGAN seed prod sebelum BE-11 live |
| BE-03 SubscriptionService aktivasi/renewal | BB-79 | **selesai — menunggu review** | `packages/domain/src/subscription/subscription.service.ts`; ledger-last idempotency; 10 test activation.spec.ts |
| BE-04 Grant | BB-80 | **selesai — menunggu review** | `SubscriptionService.grant(memberId, planCode, months?)`; ledger `kind='grant'` transactionId NULL (idempotensi = tugas script BE-20); 6 test grant.spec.ts |
| BE-05 Seat management | BB-81 | **selesai — menunggu review** | `seat.service.ts`: invite rotasi (alfabet tanpa 0/O/1/I), claim = conditional UPDATE single-statement (race-safe), remove/leave matikan lazy enrollment seketika; 8 test seats.spec.ts |
| BE-06 EntitlementService + lazy enrollment | BB-82 | **selesai — menunggu review** | `entitlement.service.ts`; retail = valid by existence (expired_date legacy diabaikan); + upgrade-lifetime di `grantCourseEnrollment`; + fix seat zombie; 7 test entitlement.spec.ts |
| BE-07 Event bus | BB-83 | **selesai — menunggu review** | `packages/common/src/events/subscription-events.ts`; 4 event; isolasi sync throw (lebih kuat dari bus commerce) |
| BE-08 Listener commerce | BB-84 | **selesai — menunggu review** | `subscription-activation.listener.ts` + `revokeByTransactionId`; wired ke `registerDomainListeners`; 6 test activation-listener.spec.ts |
| BE-09 Komisi flat | BB-85 | **selesai — menunggu review** | short-circuit di `commitCommissionsForPayment`; 1 row L1 `schemaType='FLAT'`, rate dari plan; renewal = flag RC OR ledger (`transactionId` lain non-NULL, grant tak dihitung); 9 test flat-commission.spec.ts |
| BE-10 Gate media | BB-86 | **selesai — menunggu review** | `MediaService.assertEnrollment` → delegasi `assertCourseAccess`; signature tetap |
| BE-11 Product list/detail | BB-87 | **selesai — menunggu review** | isPurchase/badge/purchased/not_purchased (typed+raw) subscription-aware; `type='subscription'` excluded dari list default; 9 test product-subscription.spec.ts |
| BE-12 RC webhook | BB-88 | **selesai — menunggu review** | EXPIRATION → `expireByProviderRef`; CANCELLATION cabang `cancel_reason` (UNSUBSCRIBE/BILLING_ERROR = intent, lainnya/kosong = refund legacy); DTO +3 field |
| BE-13 purchase-ingest | BB-89 | **selesai — menunggu review** | SKU resolve iOS OR Android; passthrough `subscription:{providerRef,expiresAt}` di event; attributionKey per-periode utk produk plan; 6 test rc-subscription.spec.ts |
| BE-14 Guard checkout | BB-90 | **selesai — menunggu review** | guard di `CheckoutService.start`; plan beda 400, plan sama = renewal OK, seat orang lain 400 (zombie tidak blok); 5 test checkout-guard.spec.ts |
| BE-15 Job renewal reminder | BB-91 | **selesai — menunggu review** | `jobs/subscription-renewal-reminder.ts`; insert-first, bucket terkecil dulu, suppression ter-scope per siklus expiry; ⚠️ jangan aktif di prod sebelum template bb-comms siap |
| BE-16 Job expire | BB-92 | **selesai — menunggu review** | `jobs/subscription-expire.ts`; hanya past-grace, idempotent, emit expired |
| BE-17 Notification listeners | BB-93 | **selesai — menunggu review** | `subscription.listener.ts` + 4 label baru; commerce listener skip product ber-plan (anti-dobel); refund silent; 9 test jobs.spec.ts |
| BE-18 Email receipt + bb-comms | BB-94 | **backend selesai — menunggu review; BLOCKED bb-comms utk end-to-end** | `subscription-email.listener.ts` (Activated/Renewed by refId=subId); commerce email skip product ber-plan; 3 template bb-comms = kerjaan eksternal terpisah |
| BE-19 Modul HTTP /subscription | BB-95 | **selesai — menunggu review** | modul `apps/mobile-api/src/modules/subscription/`; 7 endpoint (plans public, me 3-role, seat ops, cancel web/IAP-aware); + `cancelIntentByOwner`; 5 test subscription-http.spec.ts |
| BE-20 Script grant + eligibility | BB-96 | **selesai — menunggu review** | `pnpm grant:subscription`; eligibility = commerce_transactions PAID **+ legacy MariaDB langsung** (course_payment+bundle, brainboost, `amount−amount_voucher`) via legacyId+member_redirect; guard ledger `kind='grant'`; smoke nyata: 179 eligible, 655 legacy unmapped; 4 test grant-script.spec.ts |
| BE-21 Integration tests | BB-97 | **selesai — menunggu review** | audit DoD PRD vs 14 spec existing (semua item ter-cover) + `edge-cases.spec.ts` menambal 6 gap: EXPIRED→repurchase sub baru, invite penuh 400, race duplikat konkuren, race initial paralel (branch retry), voucher-bypass 100%, in-grace entitled. Suite subscription 15 file / 93 test; full 567/567 |
| BE-22 Docs + reporting | BB-98 | **selesai — menunggu review** | `docs/subscription-port.md` (15 aturan bisnis + runbook launch 7 langkah + 6 query reporting tervalidasi jalan) + CLAUDE.md §5/§7 + rewrite-progress.md |

## Urutan pengerjaan yang disarankan (dependency)

1. BE-01 → BE-02 (fondasi schema + seed)
2. BE-03 → BE-04, BE-07 (service inti + event bus)
3. BE-05, BE-06 (seat + entitlement — bisa paralel)
4. BE-08, BE-09 (integrasi commerce/affiliate)
5. BE-10, BE-11, BE-14 (gate + product surface)
6. BE-12, BE-13 (jalur RevenueCat)
7. BE-15, BE-16, BE-17, BE-18 (jobs + notif + email)
8. BE-19, BE-20 (HTTP + script)
9. BE-21 → BE-22 (test menyeluruh + docs)

## Log keputusan & penemuan

> Tambahkan entri bertanggal untuk hal non-obvious yang ditemukan saat implementasi (edge case legacy, keputusan desain di luar PRD, blocker). Ini yang dibaca sesi berikutnya.

- 2026-07-07: Tracker dibuat. Semua issue BB-77…BB-98 assigned, semuanya Backlog. Angka final `renewalAffiliateRate` masih menunggu COO (placeholder 20%).
- 2026-07-07 (BE-01): Migration **ditulis tangan** via `prisma migrate diff` + `migrate deploy`, BUKAN `migrate dev` — `migrate dev` butuh TTY dan mendeteksi drift `bo_*` di `bb_trial` (drift itu disengaja: tabel backoffice legacy dipertahankan di DB dev, di luar schema). Jangan jalankan `migrate dev`/`reset` di `bb_trial`.
- 2026-07-07 (BE-01): **Test DB (localhost:5433/bb) ditemukan rusak** — migration `20260525130001` nyangkut FAILED sejak 24 Juni + drift akibat `db push`, sehingga ±75 test sudah gagal sebelum BE-01 (bukan regresi). Diperbaiki via delta `migrate diff` + `migrate resolve --applied` (7 migration). `bo_*` di test DB ikut ter-drop (benar, karena sudah keluar dari schema). Hasil: 470/470 hijau.
- 2026-07-13 (BE-11, tambahan pasca-review): field response baru **`viaSubscription: boolean`** di product list + course detail (+ varian public, selalu false) — true ⇔ dimiliki HANYA karena sub aktif; **retail valid menang** (`isPurchased=true, viaSubscription=false`). Untuk mobile bedakan badge "Dimiliki" vs "Termasuk langganan". Detail di komentar BB-87.
- 2026-07-10 (BE-03, amandemen pasca-review): **Renewal math diubah dari `max(now, expiresAt)` menjadi anchor ke `expiresAt`** — perpanjangan saat grace tidak lagi memberi "bonus waktu" (expired 9 Jul + bayar 10 Jul → 9 Jul tahun depan, bukan 10 Jul). Keputusan user: grace = napas untuk bayar. Konsisten dengan perilaku anchor store di jalur IAP. Detail di komentar BB-79. Kerugian maksimal member = durasi grace (7 hari).
- 2026-07-08 (BE-20): **Eligibility TIDAK bisa dari `commerce_transactions` saja** — migrasi legacy tidak membawa transaksi (hanya enrollment tanpa nominal). Ditemukan user saat review scope BB-96 (komentar koreksi di issue). Fix: script query legacy MariaDB langsung (`course_payment` + `product_bundle_payment` SUCCESS, brainboost, `GREATEST(amount−amount_voucher,0)` — `payment_amount` sering NULL, jangan dipakai), map via `members.legacy_id` + `member_redirect`. Mode eligibility menolak jalan tanpa `LEGACY_DB_*` dan hanya hidup selama masa transisi. Smoke nyata: 46.070 legacy paying members → **179 eligible >2jt** (hampir semua murni legacy — bukti SQL lama akan menghasilkan daftar kosong), **655 paying member legacy tidak punya akun baru** (bahan investigasi migrasi terpisah).
- 2026-07-07 (BE-12): Dua test lama `revenuecat-webhook.spec.ts` meng-assert "EXPIRATION di-skip" — perilaku itu memang diganti; probe event diganti ke `TEST`. Catatan: `rc-subscription.spec.ts` & `revenuecat-webhook.spec.ts` sama-sama seed credential `revenuecat` → tidak boleh jalan file-parallel (root runner memang `--no-file-parallelism`, aman).
- 2026-07-07 (BE-07): TypedEmitter existing (`commerce-events`/`affiliate-events`/`notification-events`) punya **flaw laten**: `Promise.resolve(listener(p))` tidak menangkap **sync throw** — bisa lolos ke EventEmitter. Bus subscription pakai async-IIFE wrapper (aman dua-duanya). Bus lama BELUM diperbaiki (di luar scope; kandidat cleanup terpisah).
- 2026-07-07 (BE-08): Sampai BE-09 selesai, pembelian produk subscription masih memicu jalur komisi multilevel legacy (listener commerce existing) — jangan uji pembelian sub dengan affiliate attribution di env yang datanya dipakai, atau tunggu BE-09.
- 2026-07-07 (BE-06): **Seat zombie** — seat di sub EXPIRED/CANCELED masih memegang `member_id` dan memblokir `uniq_active_seat_per_member` saat member itu beli/claim sub baru (ketangkap test). Fix: release-on-demand di `createInitial` + `claimSeat` (`updateMany where subscription NOT ACTIVE`). Seat di sub ACTIVE-in-grace TIDAK dilepas (masih entitled).
- 2026-07-07 (BE-03): **P2002 dari partial index dilaporkan Prisma per NAMA KOLOM** (`meta.target=['transaction_id']`), bukan nama constraint — matcher idempotensi di `subscription.service.ts` mencocokkan kolom. Ledger insert = write TERAKHIR dalam transaksi (P2002 → seluruh tx rollback → no-op bersih).
- 2026-07-07 (BE-01): 3 partial unique index (`uniq_active_sub_per_owner`, `uniq_active_seat_per_member`, `uniq_activation_tx`) = SQL manual di migration; **terverifikasi Prisma 5.22 mengabaikannya saat diff** (tidak dianggap drift). Kalau upgrade Prisma major, re-verify perilaku ini.
