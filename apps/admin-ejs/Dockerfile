# syntax=docker/dockerfile:1.7
# Build from repo ROOT (needs packages/, prisma/, lockfile):
#   docker build -f apps/admin-ejs/Dockerfile -t bb/admin-ejs .
# Server-rendered EJS: views/ + public/ ship in the deploy tree and are resolved
# via __dirname/../views (see apps/admin-ejs/src/app.ts).
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
 && pnpm -F @bb/admin-ejs build

# deploy copies the package dir, so views/ + public/ come along automatically.
RUN pnpm --filter=@bb/admin-ejs --prod --legacy deploy /app \
 && cp -R /repo/node_modules/.prisma /app/node_modules/.prisma

# ---------- runtime ----------
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production ADMIN_PORT=3002
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app ./
USER node
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.ADMIN_PORT||3002)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
