# Brainboost Backend — Technical Handbook

Dokumentasi teknis `bb-backend-new`: backend mobile Brainboost (Express + TypeScript + Prisma + PostgreSQL), rewrite penuh dari platform legacy `tribelio-platform` (PHP/Cresenity).

Handbook ini adalah **lapisan referensi**: ringkas, terstruktur, dan selalu menunjuk ke sumber kanonis (kode, schema, atau port-doc) untuk detail lebih dalam. Untuk mencoba API secara interaktif, gunakan Swagger UI di `/api/docs`.

---

## Peta dokumen

### Bab umum

| Bab | Isi |
|---|---|
| [01 — Arsitektur](01-architecture.md) | Stack, layout monorepo, module pattern, request lifecycle, event bus, background jobs |
| [02 — Database](02-database.md) | 61 model Prisma dikelompokkan per domain, ERD, konvensi schema |
| [03 — Konvensi API](03-api-conventions.md) | Response envelope, auth JWT, pagination, error codes, bindRoute/OpenAPI |
| [04 — API Reference](04-api-reference.md) | **Generated** — tabel semua endpoint per modul. Regenerate: `pnpm docs:api` |

### Per fitur

| Fitur | Halaman | Status halaman |
|---|---|---|
| Commerce (checkout, payment, voucher) | [features/commerce.md](features/commerce.md) | ✅ |
| Subscription (Phase 1 annual, seat-based) | [features/subscription.md](features/subscription.md) | ✅ |
| Auth & Register | [features/auth.md](features/auth.md) | ✅ |
| Account, Profile & Member | [features/account-profile.md](features/account-profile.md) | ✅ |
| Affiliate (attribution, komisi, disbursement, KYC) | [features/affiliate.md](features/affiliate.md) | ✅ |
| Product & Course (+ media/BunnyCDN) | [features/product-course.md](features/product-course.md) | ✅ |
| Community (topic, post, comment, network, report) | [features/community.md](features/community.md) | ✅ |
| Notification (feed + FCM push + outbox comms) | [features/notification.md](features/notification.md) | ✅ |
| Listening Tracker & Purchase Ingest | [features/tracker-ingest.md](features/tracker-ingest.md) | ✅ |
| Upload, Location, Banner | [features/upload-location-banner.md](features/upload-location-banner.md) | ✅ |
| Operations — workers & jobs | [operations/workers.md](operations/workers.md) | ✅ |
| Operations — env & runtime settings | [operations/environment.md](operations/environment.md) | ✅ |

> Service **bb-comms** (delivery WA/email/SMS) didokumentasikan di repo-nya sendiri: `bb-comms/docs/README.md`. Sisi produsen (outbox + relay) tetap di sini — lihat [notification](features/notification.md) dan [workers](operations/workers.md).

---

## Status modul (ringkas)

Status detail per modul + blocker: [`docs/specs/rewrite-progress.md`](../specs/rewrite-progress.md).

| Modul | Status | Catatan |
|---|---|---|
| auth, account, member, profile | ✅ Selesai | OAuth→JWT, register inactive-until-verified |
| location, upload, banner, product, media | ✅ Selesai | Upload → S3; media = proxy BunnyCDN Stream |
| topic, post, comment, reply, network, report | ✅ Selesai | Community penuh |
| notification | ✅ Selesai | FCM v1 push; pending kredensial live |
| commerce | ✅ Selesai | Xendit-only; pending QA sandbox manual |
| subscription | ✅ Selesai | Phase 1 annual; pending template bb-comms + SKU store + rate COO |
| affiliate | 🟡 Sebagian | Program/attribution/visit selesai; payout parity test pending |
| disbursement | 🟡 Sebagian | Flow lengkap di `@bb/domain`; approval UI di repo backoffice-bb |
| legacy resync | ✅ Selesai | `apps/resync-worker` — tool transisi, dibuang setelah cutover |
| backoffice | ⬜ Belum | Plan: [`docs/specs/backoffice-port-plan.md`](../specs/backoffice-port-plan.md) |

---

## Cara pakai handbook ini

- **Orang baru di repo?** Mulai dari [01 — Arsitektur](01-architecture.md), lalu [02 — Database](02-database.md).
- **Mau tahu fitur X pakai endpoint & tabel apa?** Buka halaman fitur — tiap halaman punya struktur seragam: *Overview → Endpoint → Tabel database → Flow → Business rules → Events & jobs → Referensi*.
- **Butuh detail desain / sejarah keputusan?** Tiap halaman fitur menaut ke port-doc aslinya di [`docs/specs/`](../specs/) (mis. `commerce-port.md`, `subscription-port.md`) dan ADR di [`docs/adr/`](../adr/).
- **Butuh coba request?** Swagger UI: `http://localhost:3000/api/docs` (semua route terdaftar otomatis via `bindRoute`).

> ⚠️ Aturan sinkronisasi: kalau lu mengubah endpoint, schema, atau business rule — update halaman handbook terkait di PR yang sama. Handbook yang basi lebih buruk daripada tidak ada.
