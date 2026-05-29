# syntax=docker/dockerfile:1
# Build from repo root: docker build -f apps/mobile-api/Dockerfile -t bb/mobile-api .
# NOTE: not validated locally (no Docker in dev env); conventional pnpm-deploy multi-stage.
FROM node:20-slim AS base
ENV CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm prisma:generate
RUN pnpm build:packages && pnpm -F @bb/mobile-api build
RUN pnpm deploy --filter=@bb/mobile-api --prod /app

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /repo/apps/mobile-api/dist ./dist
COPY --from=build /repo/node_modules/.prisma ./node_modules/.prisma
EXPOSE 3000
CMD ["node", "dist/main.js"]
