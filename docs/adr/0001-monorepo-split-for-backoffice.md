# ADR-0001: Monorepo split for backoffice

- **Status:** Proposed
- **Date:** 2026-05-26
- **Deciders:** brainboost@tribelio.com
- **Related:** [`docs/backoffice-port-plan.md`](../backoffice-port-plan.md)

## Context

`bb-backend-new` was scoped as the mobile backend rewrite of `tribelio-platform`. We now need to add a **backoffice product-ops API** (port of legacy Tribelio admin web + Oracle methods — see `docs/backoffice-port-plan.md`). Estimated surface: ~140 P0/P1 JSON endpoints across 12 sub-domains (auth/2FA, sales, refund, withdraw, balance-adjust, affiliate-admin, moderation, dashboard, insight, search, integration, feedback).

Three deployment shapes were on the table:

| Option | Shape |
|---|---|
| A | One Express app, backoffice = `src/modules/backoffice/` inside `bb-backend-new`. Single deploy, shared process. |
| B | Two repos (`bb-backend-new` mobile API, new `bb-backoffice` admin API). Each owns its own `prisma/schema.prisma`. |
| C | One git repo, pnpm monorepo. `prisma/` + domain services in shared `packages/*`. Mobile + backoffice live in `apps/*`, independent deploys. |

Concerns driving the decision:

1. **Prisma schema drift.** Two independently-owned schemas diverge fast. Migration race conditions are unrecoverable in prod.
2. **Process coupling.** A single Node process means a heavy admin query (PDF export, CSV stream, aggregation over `CommerceTransaction × AffiliateCommission`) blocks the mobile event loop. A crash in a backoffice handler (memory leak, uncaught throw, infinite loop) brings down mobile traffic. Memory footprint is shared.
3. **Deploy independence.** Mobile API has tight latency SLA. Backoffice changes shouldn't restart mobile, force mobile regression CI, or risk mobile rollback when a backoffice bug ships.
4. **Domain logic reuse.** Both apps need the same `computeAmount`, `getPerformanceTier`, `walkInviterChain`, voucher rules, notification producer, commerce checkout. Duplicating these violates `[[project_rewrite_context]]` — affiliate accuracy parity is the rewrite's hardest constraint; off-by-one in a duplicated formula is a payout bug.
5. **Single-tenant simplicity.** No multi-tenant requirement means no need for repo-level isolation per tenant. Process-level isolation (Option C) is sufficient.

## Decision

**Adopt Option C — pnpm monorepo, one git repo, multiple deployable apps, shared packages.**

### Target structure

```
bb-platform/                              # repo root (renamed from bb-backend-new)
  pnpm-workspace.yaml
  package.json
  tsconfig.base.json
  prisma/
    schema.prisma                         # SINGLE source of truth
    migrations/
    seeds/
  packages/
    db/                                   # @bb/db — Prisma client export
    common/                               # @bb/common — exceptions, envelope, openapi, validation, jwt, logger, async-handler
    domain/                               # @bb/domain — commerce, affiliate, notification, voucher (services + pure rules; no Express)
  apps/
    mobile-api/                           # current mobile modules (auth, account, member, product, post, …)
    backoffice-api/                       # new JSON product-ops API (per docs/backoffice-port-plan.md)
    admin-ejs/                            # current src/modules/admin/ (internal sysadmin EJS, kept as-is)
  docs/
    adr/
    backoffice-port-plan.md
    backoffice-port/
    …
```

### Sharing rule (enforced one-direction)

| Layer | Contains | May import |
|---|---|---|
| `packages/db` | Prisma schema + client | (nothing) |
| `packages/common` | Pure cross-cutting: exceptions, response envelope, OpenAPI registry, validation middleware, JWT util, logger, async-handler | `@bb/db` only if needed |
| `packages/domain` | Business rules + services both apps invoke: commerce checkout, affiliate compute, notification producer, voucher redeem, refund logic. Pure functions + Prisma calls. **No Express types.** | `@bb/db`, `@bb/common` |
| `apps/*` | Routes, controllers, DTOs, OpenAPI bindings, app-specific middleware (e.g. member `authGuard` vs admin `backofficeGuard`). Express-aware. | `@bb/db`, `@bb/common`, `@bb/domain` |

Apps must not import from each other. Packages must not import from apps. Enforced via lint rule + `tsconfig` path config.

### Migration deploy rule

Single shared schema demands discipline. Every schema change ships in a backward-compatible window:

1. PR that touches `prisma/schema.prisma` gets `db-migration` label.
2. CI runs `prisma migrate deploy` **before** any app deploys.
3. Apps deploy in order: `mobile-api` first (live traffic), then `backoffice-api`, then `admin-ejs`.
4. **Additive-only inside one release.** Drop column = two releases: (1) stop reading, add new column, dual-write; (2) drop old column after both apps have shipped (1).
5. No raw migration outside Prisma. No manual DBeaver edits.

### Independent deploy

| App | Port | Image | Trigger |
|---|---|---|---|
| `mobile-api` | 3000 | `bb/mobile-api:<sha>` | changes in `apps/mobile-api/**` or `packages/**` |
| `backoffice-api` | 3001 | `bb/backoffice-api:<sha>` | changes in `apps/backoffice-api/**` or `packages/**` |
| `admin-ejs` | 3002 | `bb/admin-ejs:<sha>` | changes in `apps/admin-ejs/**` or `packages/**` |

Packages change → all three rebuild + redeploy (rolling). App-only change → that app redeploys, others untouched.

### Module ownership map (final)

| Concern | Where |
|---|---|
| Mobile API (member-facing) | `apps/mobile-api` |
| Backoffice JSON API (`/api/backoffice/*`) | `apps/backoffice-api` |
| Internal sysadmin EJS (`/admin/*`) | `apps/admin-ejs` |
| Prisma schema + migrations + seeds | repo root `prisma/` |
| Shared services (commerce, affiliate, notification, voucher) | `packages/domain` |
| Auth utils, envelope, OpenAPI, exceptions, middleware | `packages/common` |

## Consequences

### Positive

- **Drift impossible.** One `schema.prisma`, one migration history.
- **Process isolation.** Backoffice crash, memory leak, or blocking PDF export does not affect mobile latency or uptime.
- **Independent deploy cadence.** Backoffice ships hourly without rebooting mobile.
- **Shared business rules.** `computeAmount` is one function imported by both apps — payout parity stays intact.
- **Cleaner RBAC surface.** `backofficeGuard` lives only in `apps/backoffice-api`, cannot accidentally be mounted on mobile routes.
- **Test partitioning.** `pnpm -F mobile-api test` runs mobile-only tests; backoffice changes don't trigger full mobile suite (unless `packages/*` touched).
- **Extraction-ready.** If we ever need true repo split, monorepo layout already encodes package boundaries — `git filter-branch` per app/package is mechanical.

### Negative

- **One-time setup cost.** ~1-2 days: workspace init, extract packages, rewrite imports, update CI matrix, three Dockerfiles.
- **Migration discipline required.** Single schema = backward-compat rule (two-phase drops) is mandatory; one careless migration breaks both apps.
- **Cross-package refactor PR is wide.** Renaming a service in `@bb/domain` may touch both apps in the same PR.
- **pnpm workspace learning curve.** Devs need `pnpm -F`, workspace protocol (`workspace:*`), and shared `tsconfig.base.json` literacy.
- **CI matrix complexity.** Per-app Dockerfile + per-app deploy job + path-filter triggers. More YAML to maintain.
- **Repo rename.** `bb-backend-new` → `bb-platform`. One-time clone/remote update for everyone.

### Neutral

- `legacyId` columns, business rules in CLAUDE.md §5, and OpenAPI envelope all carry over unchanged.
- Tests still hit real Postgres per `[[feedback_tooling]]`. Vitest config is workspace-aware.
- `pnpm dev` script gains workspace targets: `pnpm dev:mobile`, `pnpm dev:backoffice`, `pnpm dev:admin`.

## Alternatives considered

### A. Single app, module inside `bb-backend-new`

Rejected. Concerns 2 (process coupling) and 3 (deploy independence) unsolved. Heavy admin query still blocks mobile event loop. Backoffice crash kills mobile traffic. Mobile CI runs on every backoffice PR.

### B. Two separate repos, two schemas

Rejected. Concern 1 (drift) unsolved. Concern 4 (shared domain logic) unsolved — domain code duplicates or gets pulled into an ad-hoc npm package, which is monorepo Option C without the benefits. Two-phase migrations across repos with no shared schema are effectively impossible to coordinate safely.

## Revisit triggers

Re-open this ADR if any of these happen:

- Monorepo build time exceeds 5 min on CI.
- A `packages/*` change forces full redeploy weekly or more often.
- Backoffice + mobile teams diverge organisationally and want repo-level autonomy.
- We add a third independently-deployed app where the shared packages start to feel forced (e.g. a public marketing site that has no Prisma dependency).
- Compliance audit requires repo-level access isolation (admin code reviewers must not see mobile code).

## Implementation plan

Tracked separately as the migration script. Steps:

1. `pnpm init` workspace + `pnpm-workspace.yaml` at root.
2. Move `prisma/` to root (already there). Create `packages/db` exporting `prisma` client.
3. Extract `src/common/` → `packages/common`. Rewrite imports `@/common/*` → `@bb/common/*`.
4. Extract domain-shared services (`src/modules/commerce/`, `src/modules/affiliate/`, `src/modules/notification/`, voucher logic) → `packages/domain`. Controllers stay in apps.
5. `src/modules/{auth,account,member,product,post,…}` → `apps/mobile-api/src/modules/`. Rewrite imports.
6. `src/modules/admin/` → `apps/admin-ejs/`. Rewrite imports.
7. Scaffold `apps/backoffice-api/` per `docs/backoffice-port-plan.md` §1.
8. Per-app `package.json`, `tsconfig.json`, `Dockerfile`, `vitest.config.ts`.
9. CI: path-filter triggers per app, parallel build matrix.
10. Update `CLAUDE.md` §1 (stack delta), §2 (legacy map), §7 (progress) to reflect new layout.
11. `git mv` operations one PR per package/app to keep diff reviewable.
12. Rename `bb-backend-new` → `bb-platform`.

Sprint 1 backoffice work (per `docs/backoffice-port-plan.md` §4) starts **after** monorepo extraction lands.
