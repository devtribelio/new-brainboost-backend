# bb-backend

Brainboost backend untuk aplikasi mobile. Stack: **Express + TypeScript + Prisma (Postgres)** dengan struktur modular ala NestJS (controller / service / module / DTO per fitur).

## Prasyarat

- Node.js >= 20
- pnpm >= 9
- PostgreSQL berjalan lokal (atau remote yang bisa diakses)

## Setup

```bash
pnpm install
cp .env.example .env
# edit .env: minimal DATABASE_URL, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET

pnpm prisma:generate
pnpm prisma:migrate
pnpm dev
```

Server default jalan di `http://localhost:3000`.

## Script utama

| Script | Fungsi |
|--------|--------|
| `pnpm dev` | Jalankan server dev (tsx watch) |
| `pnpm build` | Compile TypeScript ke `dist/` |
| `pnpm start` | Jalankan hasil build (`node dist/main.js`) |
| `pnpm test` | Jalankan unit & integration test (Vitest) |
| `pnpm lint` | Linting via ESLint |
| `pnpm format` | Format kode via Prettier |
| `pnpm prisma:migrate` | Buat / apply migrasi Prisma |

## Struktur folder

```
src/
├── main.ts                  # Bootstrap server
├── app.ts                   # Express app + register modules
├── config/                  # env & PrismaClient singleton
├── common/                  # middlewares, exceptions, utils, interfaces
├── core/                    # module loader (NestJS-like)
└── modules/                 # fitur per domain (auth, post, comment, ...)
```

Setiap modul fitur memiliki pola:

```
modules/<feature>/
├── <feature>.controller.ts  # @injectable class — handler HTTP
├── <feature>.service.ts     # @injectable class — business logic
├── <feature>.routes.ts      # rakit Express Router + register controller
├── <feature>.module.ts      # AppModule { prefix, routes }
└── dto/                     # class-validator DTO
```

Daftar endpoint mengikuti kontrak di [API_ENDPOINTS.md](./API_ENDPOINTS.md).

## Testing

Testing memakai Vitest + Supertest. Test integration menyentuh server Express via `request(app)`. Tambahkan spec baru di `tests/*.spec.ts` atau berdampingan dengan source file (`*.spec.ts`).
