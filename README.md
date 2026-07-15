# Brainboost Backend (bb-platform)

Backend mobile Brainboost — rewrite penuh dari platform legacy `tribelio-platform` (PHP/Cresenity). **pnpm monorepo**: Express + TypeScript + Prisma (PostgreSQL).

> **Dokumentasi teknis lengkap: [`docs/handbook/`](docs/handbook/README.md)** — arsitektur, database (ERD), konvensi API, referensi 100+ endpoint, halaman per fitur (auth, commerce, subscription, affiliate, dll.), dan operations. Mulai dari sana kalau baru di repo ini.

## Prasyarat

- Node.js ≥ 20
- pnpm ≥ 9
- PostgreSQL berjalan lokal (atau remote yang bisa diakses)

## Setup

```bash
pnpm install
cp .env.example .env
# edit .env: minimal DATABASE_URL, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET

pnpm prisma:generate
pnpm prisma:migrate
pnpm dev:mobile
```

Server dev jalan di `http://localhost:3000` — Swagger UI di `http://localhost:3000/api/docs`.

## Struktur monorepo

```
packages/
  db/        @bb/db        # Prisma client singleton
  common/    @bb/common    # middlewares, openapi, exceptions, services, utils, config
  domain/    @bb/domain    # business services & rules (tanpa Express) + jobs
apps/
  mobile-api/              # API member-facing :3000 — modul HTTP per fitur
  resync-worker/           # sync inkremental legacy MariaDB → PG (tool transisi)
  notification-worker/     # shell kosong — push FCM saat ini in-process di mobile-api
prisma/                    # schema.prisma + migrations + seeds (sumber kebenaran tunggal)
docs/handbook/             # dokumentasi teknis (baca di GitHub)
```

Pola tiap modul fitur (`apps/mobile-api/src/modules/<feature>/`):

```
<feature>.module.ts       # AppModule { name, prefix, routes }
<feature>.routes.ts       # DI manual (new Controller(new Service())) + bindRoute()
<feature>.controller.ts   # handler HTTP tipis
dto/                      # class-validator DTO
```

Semua route didaftarkan lewat `bindRoute()` — sekali panggil = route Express + entri OpenAPI. Detail pola & konvensi: [handbook 01 — Arsitektur](docs/handbook/01-architecture.md) dan [03 — Konvensi API](docs/handbook/03-api-conventions.md).

## Script utama

| Script | Fungsi |
|--------|--------|
| `pnpm dev:mobile` | Server dev mobile-api (tsx watch) |
| `pnpm build` | Build produksi semua package/app (tsup) |
| `pnpm typecheck` | Type-check seluruh workspace (`tsc -b`) |
| `pnpm test` | Unit & integration test (Vitest; butuh Postgres asli) |
| `pnpm lint` / `pnpm format` | ESLint / Prettier |
| `pnpm prisma:migrate` / `prisma:deploy` | Buat / apply migrasi Prisma |
| `pnpm jobs` | Jalankan background jobs sekali (expire payment, komisi, subscription, dll.) |
| `pnpm relay:comms` | Daemon relay `notification_outbox` → SQS → bb-comms |
| `pnpm resync` / `resync:worker` | Sync inkremental dari legacy MariaDB (masa transisi) |
| `pnpm docs:api` | Regenerate [`docs/handbook/04-api-reference.md`](docs/handbook/04-api-reference.md) dari kode routes — **wajib setelah mengubah route** |
| `pnpm seed:admin` / `seed:settings` / `seed:subscription-plans` / … | Seeder data awal |

## Dokumentasi

| Dokumen | Isi |
|---|---|
| [`docs/handbook/`](docs/handbook/README.md) | **Referensi utama** — arsitektur, database, API, per fitur, operations. Wajib di-update bersama setiap perubahan kode (lihat aturan di `CLAUDE.md` §8) |
| `http://localhost:3000/api/docs` | Swagger UI interaktif (server harus jalan) |
| [`docs/specs/`](docs/specs/) | Port-docs & design specs per fitur (sejarah keputusan, detail migrasi legacy) |
| [`API_ENDPOINTS.md`](API_ENDPOINTS.md) | Kontrak endpoint awal (historis) — versi terkini yang terawat: [handbook 04](docs/handbook/04-api-reference.md) |

## Testing

Vitest + Supertest; integration test menyentuh Express via `request(app)` dan **Postgres asli (tanpa mock DB)**. Spec ada di `apps/*/tests/` dan berdampingan dengan source (`*.spec.ts`). Jalankan dengan `pnpm test`.
