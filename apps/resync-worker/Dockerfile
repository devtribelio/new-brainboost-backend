# syntax=docker/dockerfile:1.7
# Resync worker (throwaway transition tool). Incremental legacy MariaDB → Postgres
# resync. Build from repo ROOT (needs packages/, prisma/, lockfile):
#   docker build -f apps/resync-worker/Dockerfile -t bb/resync-worker .
#
# Runs via tsx directly (same as dev/staging `pnpm resync:worker`) — no tsup build,
# because this is a temporary tool retired after cutover. Two run modes:
#   pnpm resync:worker   -> loop every RESYNC_INTERVAL_SEC (default CMD, for a Service)
#   pnpm resync          -> one-shot: run all syncers once, exit (override CMD)
# Migrations are NOT run here — the schema owner is bb-platform (`prisma:deploy`).

ARG NODE_VERSION=20-bookworm-slim
ARG PNPM_VERSION=10.33.2

# ---------- base ----------
FROM node:${NODE_VERSION} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
# openssl + ca-certificates: Prisma query engine + TLS to legacy MariaDB / RDS.
# tini: PID 1 signal forwarding so SIGTERM reaches the worker (graceful shutdown).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

# ---------- build (install deps + generate prisma client) ----------
FROM base AS build
# 1) Manifests first so `pnpm install` layer is cached until a package.json changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages/db/package.json        packages/db/
COPY packages/common/package.json    packages/common/
COPY packages/domain/package.json    packages/domain/
COPY apps/resync-worker/package.json apps/resync-worker/
# Full install (NOT --prod): the worker runs TypeScript via tsx (a devDependency)
# with --conditions=development, so it resolves @bb/common to source at runtime —
# no build step needed. mysql2 (legacy driver) comes from resync-worker deps.
RUN pnpm install --frozen-lockfile

# 2) Source + Prisma client (the worker opens its own PrismaClient).
COPY . .
RUN pnpm prisma:generate

ENV NODE_ENV=production
ENTRYPOINT ["/usr/bin/tini", "--"]
# Default = loop worker (fits a long-running FargateService). Override the command
# to `pnpm resync` for a one-shot run.
CMD ["pnpm", "resync:worker"]
