#!/usr/bin/env bash
# Deploy bb-platform ke STAGING (PM2). JALANKAN DI SERVER STAGING, dari repo root:
#   ./scripts/deploy-staging.sh [branch]
#
# Staging = PM2 di server (BUKAN ECS/CDK — itu prod, lihat deploy-prod.sh).
# Env (DATABASE_URL, dst) dibaca dari .env di server. Node/pnpm/pm2 sudah terpasang.
# VERIFIKASI dulu: pastikan ini cara deploy staging yang kamu pakai.
set -euo pipefail
BRANCH="${1:-feat/scalev-ingest-member-provisioning}"
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Checkout $BRANCH"
git fetch origin
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

echo "==> Install + prisma generate + build"
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm build

# Migration DB staging — AKTIFKAN kalau ada migration baru (idempotent, additive).
# echo "==> Migrate"; pnpm prisma migrate deploy

echo "==> Restart PM2"
# API + relay outbox (yang relevan buat ingest/claim). Cron & lainnya opsional.
pm2 restart bb-mobile-api bb-comms-relay --update-env
pm2 restart bb-backoffice-api bb-admin-ejs bb-cron bb-cron-disburse --update-env 2>/dev/null || true
pm2 save
pm2 status
