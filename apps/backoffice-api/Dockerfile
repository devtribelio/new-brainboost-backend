# syntax=docker/dockerfile:1.7
# Build from repo ROOT (needs packages/, prisma/, lockfile):
#   docker build -f apps/backoffice-api/Dockerfile -t bb/backoffice-api .
# Migrations are NOT run here — apply `pnpm prisma:deploy` as a separate job.

ARG NODE_VERSION=20-bookworm-slim
ARG PNPM_VERSION=10.33.2

# ---------- base ----------
FROM node:${NODE_VERSION} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

# ---------- build ----------
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages/db/package.json        packages/db/
COPY packages/common/package.json    packages/common/
COPY packages/domain/package.json    packages/domain/
COPY apps/mobile-api/package.json    apps/mobile-api/
COPY apps/backoffice-api/package.json apps/backoffice-api/
COPY apps/admin-ejs/package.json     apps/admin-ejs/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm prisma:generate \
 && pnpm build:packages \
 && pnpm -F @bb/backoffice-api build

RUN pnpm --filter=@bb/backoffice-api --prod --legacy deploy /app \
 && cp -R /repo/node_modules/.prisma /app/node_modules/.prisma

# ---------- runtime ----------
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production BACKOFFICE_PORT=3001
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app ./
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.BACKOFFICE_PORT||3001)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
