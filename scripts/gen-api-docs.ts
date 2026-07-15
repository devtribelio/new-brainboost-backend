/**
 * Generate docs/handbook/04-api-reference.md — endpoint tables per module —
 * by statically parsing apps/mobile-api/src/modules/*\/(*.module.ts + *.routes.ts).
 *
 * Static parse (not runtime registry import) on purpose: the runtime path pulls
 * in config/env.ts (`required()`) and every service constructor, so it needs a
 * full .env; this script needs nothing and can run in CI.
 *
 * Run: pnpm docs:api   (tsx scripts/gen-api-docs.ts)
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(__dirname, '..');
const MODULES_DIR = join(REPO_ROOT, 'apps/mobile-api/src/modules');
const OUT_FILE = join(REPO_ROOT, 'docs/handbook/04-api-reference.md');
const RATE_LIMIT_FILE = join(REPO_ROOT, 'packages/common/src/middlewares/rate-limit.middleware.ts');

interface Route {
  method: string;
  path: string;
  handlerKey: string;
  middlewares: string[];
}

interface ModuleDoc {
  name: string;
  prefix: string;
  routesFile: string;
  routes: Route[];
}

function parseModuleFile(dir: string, moduleFile: string): ModuleDoc | null {
  const src = readFileSync(join(dir, moduleFile), 'utf8');
  const name = src.match(/name:\s*'([^']+)'/)?.[1];
  const prefix = src.match(/prefix:\s*'([^']*)'/)?.[1];
  // `routes: someRoutes` → resolve the ./x.routes import it came from.
  const routesFn = src.match(/routes:\s*(\w+)/)?.[1];
  if (!name || prefix === undefined || !routesFn) return null;
  const importMatch = src.match(
    new RegExp(`import\\s*\\{[^}]*\\b${routesFn}\\b[^}]*\\}\\s*from\\s*'\\./([\\w.-]+)'`),
  );
  if (!importMatch) return null;
  const routesFile = join(dir, `${importMatch[1]}.ts`);
  return { name, prefix, routesFile, routes: parseRoutesFile(routesFile) };
}

function parseRoutesFile(file: string): Route[] {
  const src = readFileSync(file, 'utf8');
  const routes: Route[] = [];
  // Each bindRoute({ ... }) block; blocks never nest braces deeper than the
  // middlewares array, so a lazy match up to `});` is safe for this codebase.
  const blockRe = /bindRoute\(\s*\{([\s\S]*?)\}\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(src))) {
    const block = m[1];
    const method = block.match(/method:\s*'(\w+)'/)?.[1];
    const path = block.match(/path:\s*'([^']+)'/)?.[1];
    const handlerKey = block.match(/handlerKey:\s*'(\w+)'/)?.[1];
    if (!method || !path || !handlerKey) continue;
    const mwRaw = block.match(/middlewares:\s*\[([\s\S]*?)\]/)?.[1] ?? '';
    const middlewares = mwRaw
      .split(',')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    routes.push({ method: method.toUpperCase(), path, handlerKey, middlewares });
  }
  return routes;
}

/**
 * Parse rate-limit.middleware.ts → { limiterName: "N req/15 mnt per IP" }.
 * Two shapes: `makeRateLimiter(N[, windowMs])` (per IP, default window 15 mnt)
 * and inline `rateLimit({ windowMs, limit, keyGenerator? })` (keyGenerator = per member).
 */
function parseRateLimits(): Record<string, string> {
  const src = readFileSync(RATE_LIMIT_FILE, 'utf8');
  const limits: Record<string, string> = {};
  const windowLabel = (ms: number) =>
    ms % 60_000 === 0 ? (ms === 60_000 ? '1 mnt' : `${ms / 60_000} mnt`) : `${ms / 1000} dtk`;

  const DEFAULT_WINDOW_MS = 15 * 60 * 1000; // WINDOW_MS in the middleware
  for (const m of src.matchAll(/export const (\w+).*?=\s*makeRateLimiter\((\d+)(?:,\s*([\d\s*+]+))?\)/g)) {
    const ms = m[3] ? Number(eval(m[3])) : DEFAULT_WINDOW_MS;
    limits[m[1]] = `${m[2]} req/${windowLabel(ms)} per IP`;
  }
  for (const m of src.matchAll(/export const (\w+).*?=\s*rateLimit\(\{([\s\S]*?)\}\);/g)) {
    const body = m[2];
    const limit = body.match(/limit:\s*(\d+)/)?.[1];
    if (!limit) continue;
    const winRaw = body.match(/windowMs:\s*([\w\d\s*+]+),/)?.[1]?.trim();
    const ms = !winRaw || winRaw === 'WINDOW_MS' ? DEFAULT_WINDOW_MS : Number(eval(winRaw));
    const key = body.includes('keyGenerator') ? 'per member (fallback IP)' : 'per IP';
    limits[m[1]] = `${limit} req/${windowLabel(ms)} ${key}`;
  }
  return limits;
}

const RATE_LIMITS = parseRateLimits();

function authLabel(middlewares: string[]): string {
  if (middlewares.some((mw) => mw.startsWith('authGuardLenient'))) return 'JWT (lenient)';
  if (middlewares.some((mw) => mw.startsWith('optionalAuthGuard'))) return 'JWT opsional';
  if (middlewares.some((mw) => mw.startsWith('authGuard'))) return 'JWT';
  if (middlewares.some((mw) => /callbackguard|signatureguard/i.test(mw))) return 'Webhook guard';
  if (middlewares.some((mw) => /apikey|credentialguard|ingestguard/i.test(mw))) return 'API key';
  return 'Publik';
}

function otherMiddlewares(middlewares: string[]): string {
  return (
    middlewares
      .filter((mw) => !/^(authGuard|authGuardLenient|optionalAuthGuard)\b/.test(mw))
      .map((mw) => (RATE_LIMITS[mw] ? `${mw} (${RATE_LIMITS[mw]})` : mw))
      .join(', ') || '—'
  );
}

const modules: ModuleDoc[] = [];
for (const dir of readdirSync(MODULES_DIR, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const dirPath = join(MODULES_DIR, dir.name);
  for (const f of readdirSync(dirPath)) {
    if (!f.endsWith('.module.ts')) continue;
    const mod = parseModuleFile(dirPath, f);
    if (mod) modules.push(mod);
  }
}
modules.sort((a, b) => a.name.localeCompare(b.name));

const total = modules.reduce((n, mod) => n + mod.routes.length, 0);

const lines: string[] = [
  '# 04 — API Reference (generated)',
  '',
  '[⬅ Kembali ke index](README.md)',
  '',
  '> **File ini di-generate — jangan diedit manual.** Regenerate dengan `pnpm docs:api`',
  '> setelah menambah/mengubah route. Sumber: parse statis `apps/mobile-api/src/modules/*/`',
  '> (`*.module.ts` + `*.routes.ts`) oleh `scripts/gen-api-docs.ts`.',
  '',
  `Total: **${total} endpoint** dari **${modules.length} modul**. Semua path di bawah sudah termasuk mount root \`/api\` + prefix modul. Detail request/response tiap endpoint: Swagger UI \`/api/docs\`.`,
  '',
];

for (const mod of modules) {
  const rel = relative(REPO_ROOT, mod.routesFile);
  lines.push(`## ${mod.name}`, '');
  lines.push(`Prefix: \`/api${mod.prefix}\` · Sumber: \`${rel}\``, '');
  lines.push('| Method | Path | Handler | Auth | Middleware lain |');
  lines.push('|---|---|---|---|---|');
  for (const r of mod.routes) {
    const fullPath = `/api${mod.prefix}${r.path}`;
    lines.push(
      `| ${r.method} | \`${fullPath}\` | \`${r.handlerKey}\` | ${authLabel(r.middlewares)} | ${otherMiddlewares(r.middlewares)} |`,
    );
  }
  lines.push('');
}

writeFileSync(OUT_FILE, lines.join('\n'));
console.log(`Wrote ${relative(REPO_ROOT, OUT_FILE)} — ${total} endpoints, ${modules.length} modules`);
