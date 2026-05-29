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
  ],
};
