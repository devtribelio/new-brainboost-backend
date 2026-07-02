# syntax=docker/dockerfile:1.7
# Build from repo ROOT (needs packages/, prisma/, lockfile):
#   docker build -f apps/mobile-api/Dockerfile -t bb/mobile-api .
#
# This image carries THREE entrypoints (tsup bundles all of them):
#   dist/main.js               -> HTTP API           (default CMD, :3000)
#   dist/jobs-runner.js        -> cron one-shot       (override CMD)
#   dist/workers/comms-relay.js-> comms outbox relay   (override CMD)
# Run the variants by overriding the command, e.g.
#   docker run bb/mobile-api node dist/jobs-runner.js
# Migrations are NOT run here — apply `pnpm prisma:deploy` as a separate job.

ARG NODE_VERSION=20-bookworm-slim
ARG PNPM_VERSION=10.33.2

# ---------- base ----------
FROM node:${NODE_VERSION} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
# openssl + ca-certificates: required by the Prisma query engine at runtime.
# tini: PID 1 signal forwarding + zombie reaping.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

# ---------- build ----------
FROM base AS build
# 1) Manifests first so `pnpm install` is cached until a package.json changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages/db/package.json        packages/db/
COPY packages/common/package.json    packages/common/
COPY packages/domain/package.json    packages/domain/
COPY apps/mobile-api/package.json    apps/mobile-api/
RUN pnpm install --frozen-lockfile

# 2) Source + build. prisma generate writes node_modules/.prisma/client.
COPY . .
RUN pnpm prisma:generate \
 && pnpm build:packages \
 && pnpm -F @bb/mobile-api build

# 3) Prune to a production-only deploy tree (--legacy: required on pnpm v10
#    for non-injected workspaces). Then graft the generated Prisma client,
#    which pnpm deploy does not copy.
RUN pnpm --filter=@bb/mobile-api --prod --legacy deploy /app \
 && cp -R /repo/node_modules/.prisma /app/node_modules/.prisma

# ---------- runtime ----------
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production PORT=3000
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# /app from the deploy stage already contains dist/ + node_modules/ (+ prisma client).
COPY --from=build --chown=node:node /app ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
