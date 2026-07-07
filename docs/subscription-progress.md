# Subscription Phase 1 — Progress Tracker

> Sumber kebenaran progres implementasi PRD `docs/prd-subscription-backend.md`.
> **Cara resume sesi baru:** prompt — *"baca docs/prd-subscription-backend.md + docs/subscription-progress.md, lanjut task berikutnya yang belum selesai"*.
> **Aturan update (WAJIB tiap akhir sesi / selesai task):** update baris task di tabel (status, branch, catatan) dan catat keputusan/penemuan non-obvious di bagian "Log keputusan".
> **Aturan status Jira:** mulai task → flip ke **Development**; JANGAN pernah flip ke **Done** (user kelola sendiri — Done menghilangkan issue dari backlog/board). Doneness dicatat di tabel tracker ini.

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
| BE-05 Seat management | BB-81 | todo | |
| BE-06 EntitlementService + lazy enrollment | BB-82 | todo | |
| BE-07 Event bus | BB-83 | todo | |
| BE-08 Listener commerce | BB-84 | todo | |
| BE-09 Komisi flat | BB-85 | todo | |
| BE-10 Gate media | BB-86 | todo | |
| BE-11 Product list/detail | BB-87 | todo | |
| BE-12 RC webhook | BB-88 | todo | |
| BE-13 purchase-ingest | BB-89 | todo | |
| BE-14 Guard checkout | BB-90 | todo | |
| BE-15 Job renewal reminder | BB-91 | todo | ⚠️ jangan aktif di prod sebelum template bb-comms siap |
| BE-16 Job expire | BB-92 | todo | |
| BE-17 Notification listeners | BB-93 | todo | |
| BE-18 Email receipt + bb-comms | BB-94 | todo | dependensi eksternal bb-comms |
| BE-19 Modul HTTP /subscription | BB-95 | todo | |
| BE-20 Script grant + eligibility | BB-96 | todo | |
| BE-21 Integration tests | BB-97 | todo | |
| BE-22 Docs + reporting | BB-98 | todo | |

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
- 2026-07-07 (BE-03): **P2002 dari partial index dilaporkan Prisma per NAMA KOLOM** (`meta.target=['transaction_id']`), bukan nama constraint — matcher idempotensi di `subscription.service.ts` mencocokkan kolom. Ledger insert = write TERAKHIR dalam transaksi (P2002 → seluruh tx rollback → no-op bersih).
- 2026-07-07 (BE-01): 3 partial unique index (`uniq_active_sub_per_owner`, `uniq_active_seat_per_member`, `uniq_activation_tx`) = SQL manual di migration; **terverifikasi Prisma 5.22 mengabaikannya saat diff** (tidak dianggap drift). Kalau upgrade Prisma major, re-verify perilaku ini.
