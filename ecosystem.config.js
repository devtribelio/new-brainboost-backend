// PM2 process manifest for the bb-platform monorepo.
//
// Prereq: build everything once (packages then app bundles):
//   pnpm install && pnpm prisma:generate && pnpm build
// Then:
//   pm2 start ecosystem.config.js
//   pm2 logs / pm2 status / pm2 restart all / pm2 reload all
//
// Env (DATABASE_URL, JWT secrets, Xendit/Bunny/FCM, etc.) is read from the
// root .env by the app at boot (dotenv). cwd is pinned to the repo root so
// that .env resolves; ports are injected per app below. fork mode + 1
// instance each — domain event listeners run in-process, so multiple cluster
// workers would each register/emit independently (avoid until a shared bus).
const path = require('node:path');
const root = __dirname;

module.exports = {
  apps: [
    {
      name: 'bb-mobile-api',
      cwd: root,
      script: 'apps/mobile-api/dist/main.js',
      exec_mode: 'fork',
      instances: 1,
      env: { NODE_ENV: 'production', PORT: 3000 },
      max_memory_restart: '500M',
    },
    {
      name: 'bb-backoffice-api',
      cwd: root,
      script: 'apps/backoffice-api/dist/main.js',
      exec_mode: 'fork',
      instances: 1,
      env: { NODE_ENV: 'production', BACKOFFICE_PORT: 3001 },
      max_memory_restart: '400M',
    },
    {
      name: 'bb-admin-ejs',
      cwd: root,
      script: 'apps/admin-ejs/dist/main.js',
      exec_mode: 'fork',
      instances: 1,
      env: { NODE_ENV: 'production', ADMIN_PORT: 3002 },
      max_memory_restart: '400M',
    },
    {
      // Comms outbox → RabbitMQ relay (producer side of bb-comms; ADR-0002).
      // instances:1 is REQUIRED — the poll uses a plain PENDING→SENT flip, so a
      // second instance would double-publish (no FOR UPDATE SKIP LOCKED yet).
      // Idle-safe: with RABBITMQ_URL unset it logs once and leaves rows PENDING.
      name: 'bb-comms-relay',
      cwd: root,
      script: 'apps/mobile-api/dist/workers/comms-relay.js',
      exec_mode: 'fork',
      instances: 1,
      env: { NODE_ENV: 'production' },
      max_memory_restart: '200M',
    },
    {
      // Scheduled jobs, hourly lane (affiliate PENDING->BALANCE, expire stale payments).
      // One-shot per cron tick: PM2 spawns it, it runs the listed jobs once and exits,
      // PM2 waits for the next tick (autorestart:false + cron_restart). Single
      // instance = jobs fire exactly once. To move off PM2 later (ECS), point
      // EventBridge → ECS RunTask at the SAME dist/jobs-runner.js — no code change.
      // argv = job filter (see jobs-runner.ts); no args would run ALL jobs.
      name: 'bb-cron',
      cwd: root,
      script: 'apps/mobile-api/dist/jobs-runner.js',
      args: 'affiliatePendingToBalance expirePendingPayments',
      exec_mode: 'fork',
      instances: 1,
      autorestart: false,
      cron_restart: '0 * * * *', // hourly at :00 (holds are in days; cheap to run often)
      env: { NODE_ENV: 'production' },
      max_memory_restart: '300M',
    },
    {
      // Fast lane: sweep backoffice-approved payouts to Xendit every 5 minutes so a
      // MANUAL approval doesn't wait up to an hour to be executed. Idempotent — the
      // job only picks PENDING rows with approvedAt set, so overlap with the hourly
      // lane at :00 is harmless (worst case: one lane finds nothing to do).
      name: 'bb-cron-disburse',
      cwd: root,
      script: 'apps/mobile-api/dist/jobs-runner.js',
      args: 'executeApprovedDisbursements',
      exec_mode: 'fork',
      instances: 1,
      autorestart: false,
      cron_restart: '*/5 * * * *', // every 5 minutes
      env: { NODE_ENV: 'production' },
      max_memory_restart: '300M',
    },
  ],
};
