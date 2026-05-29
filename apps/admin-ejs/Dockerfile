# syntax=docker/dockerfile:1
# Build from repo root: docker build -f apps/admin-ejs/Dockerfile -t bb/admin-ejs .
# NOTE: not validated locally (no Docker in dev env); conventional pnpm-deploy multi-stage.
FROM node:20-slim AS base
ENV CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm prisma:generate
RUN pnpm build:packages && pnpm -F @bb/admin-ejs build
RUN pnpm deploy --filter=@bb/admin-ejs --prod /app

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /repo/apps/admin-ejs/dist ./dist
COPY --from=build /repo/node_modules/.prisma ./node_modules/.prisma
# Server-rendered EJS views + static assets (resolved via __dirname/../views).
COPY --from=build /repo/apps/admin-ejs/views ./views
COPY --from=build /repo/apps/admin-ejs/public ./public
EXPOSE 3002
CMD ["node", "dist/main.js"]
