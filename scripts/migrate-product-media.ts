/**
 * Per-product media migration: copy a product's Bunny videos from the legacy
 * library (157244) to the Model C library (666592) and rewrite the guids in
 * Lesson.slidesData.
 *
 *   pnpm exec tsx scripts/migrate-product-media.ts
 *       -> LIST mode: products with media + distinct-guid counts
 *   pnpm exec tsx scripts/migrate-product-media.ts --code=<code>
 *       -> dry-run for one product
 *   pnpm exec tsx scripts/migrate-product-media.ts --code=<code> --apply
 *       -> copy the videos + rewrite the DB
 *
 * The old->new guid map is persisted in scripts/media-guid-map.json so copies
 * are never duplicated across runs.
 *
 * Requires BUNNY_ACCOUNT_API_KEY in .env.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { prisma } from '@bb/db';

const ACCOUNT_KEY = process.env.BUNNY_ACCOUNT_API_KEY ?? '';
const REFERER = process.env.BUNNY_REFERER || 'https://brainboost.id';
const SRC_LIBRARY_ID = 157244;
const SRC_CDN = 'vz-5439ef3e-878.b-cdn.net';
const DST_LIBRARY_ID = 666592;
const API = 'https://video.bunnycdn.com';
const MAP_PATH = 'scripts/media-guid-map.json';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const EMBED_RE = new RegExp(`(iframe\\.mediadelivery\\.net/embed/)(\\d+)(/)(${UUID})`, 'g');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const CODE = args.find((a) => a.startsWith('--code='))?.slice('--code='.length);

interface Slide {
  type?: unknown;
  data?: { url?: unknown; audio?: { guid?: unknown; videoLibraryId?: unknown } };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function loadMap(): Record<string, string> {
  return existsSync(MAP_PATH) ? (JSON.parse(readFileSync(MAP_PATH, 'utf8')) as Record<string, string>) : {};
}
function saveMap(m: Record<string, string>): void {
  writeFileSync(MAP_PATH, `${JSON.stringify(m, null, 2)}\n`);
}

/** Collect distinct Bunny guids referenced by a lesson's slidesData. */
function guidsInSlides(slides: Slide[]): string[] {
  const out = new Set<string>();
  for (const s of slides) {
    const type = typeof s?.type === 'string' ? s.type : '';
    const d = s?.data ?? {};
    if (type === 'AudioTemplate' && typeof d.audio?.guid === 'string') out.add(d.audio.guid);
    else if (type === 'VideoTemplate' && typeof d.url === 'string') {
      for (const m of d.url.matchAll(EMBED_RE)) out.add(m[4]);
    }
  }
  return [...out];
}

/** Rewrite one lesson's slides with the old->new guid map. Returns a new array. */
function rewriteSlides(slides: Slide[], map: Record<string, string>): { slides: Slide[]; changed: number } {
  let changed = 0;
  const next = structuredClone(slides);
  for (const s of next) {
    const type = typeof s?.type === 'string' ? s.type : '';
    const d = s?.data ?? {};
    if (type === 'AudioTemplate' && typeof d.audio?.guid === 'string' && map[d.audio.guid]) {
      d.audio.guid = map[d.audio.guid];
      d.audio.videoLibraryId = String(DST_LIBRARY_ID);
      changed += 1;
    } else if (type === 'VideoTemplate' && typeof d.url === 'string') {
      const rewritten = d.url.replace(EMBED_RE, (full, pre, _lib, slash, guid) =>
        map[guid] ? `${pre}${DST_LIBRARY_ID}${slash}${map[guid]}` : full,
      );
      if (rewritten !== d.url) {
        d.url = rewritten;
        changed += 1;
      }
    }
  }
  return { slides: next, changed };
}

const apiKeyCache = new Map<number, string>();
async function libraryApiKey(libraryId: number): Promise<string> {
  if (apiKeyCache.has(libraryId)) return apiKeyCache.get(libraryId) as string;
  const r = await fetch(`https://api.bunny.net/videolibrary/${libraryId}`, {
    headers: { AccessKey: ACCOUNT_KEY, accept: 'application/json' },
  });
  if (r.status !== 200) throw new Error(`videolibrary/${libraryId} -> HTTP ${r.status}`);
  const key = String(((await r.json()) as { ApiKey?: string }).ApiKey ?? '');
  if (!key) throw new Error(`no ApiKey on library ${libraryId}`);
  apiKeyCache.set(libraryId, key);
  return key;
}

/** Copy one source guid into library 666592; returns the new guid. */
async function copyVideo(srcGuid: string): Promise<string> {
  const srcKey = await libraryApiKey(SRC_LIBRARY_ID);
  const dstKey = await libraryApiKey(DST_LIBRARY_ID);

  const metaR = await fetch(`${API}/library/${SRC_LIBRARY_ID}/videos/${srcGuid}`, {
    headers: { AccessKey: srcKey, accept: 'application/json' },
  });
  const title =
    metaR.status === 200 ? String(((await metaR.json()) as { title?: string }).title ?? '') : '';

  const createR = await fetch(`${API}/library/${DST_LIBRARY_ID}/videos`, {
    method: 'POST',
    headers: { AccessKey: dstKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ title: title || `migrated-${srcGuid}` }),
  });
  if (createR.status !== 200) throw new Error(`create -> HTTP ${createR.status}`);
  const newGuid = String(((await createR.json()) as { guid: string }).guid);

  const fetchR = await fetch(`${API}/library/${DST_LIBRARY_ID}/videos/${newGuid}/fetch`, {
    method: 'POST',
    headers: { AccessKey: dstKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      url: `https://${SRC_CDN}/${srcGuid}/play_720p.mp4`,
      headers: { Referer: REFERER },
    }),
  });
  if (fetchR.status !== 200) throw new Error(`fetch -> HTTP ${fetchR.status}`);

  for (let i = 0; i < 100; i += 1) {
    await sleep(6000);
    const vR = await fetch(`${API}/library/${DST_LIBRARY_ID}/videos/${newGuid}`, {
      headers: { AccessKey: dstKey, accept: 'application/json' },
    });
    if (vR.status !== 200) continue;
    const v = (await vR.json()) as { status?: number };
    if (v.status === 4) return newGuid;
    if (v.status === 5 || v.status === 6) throw new Error(`encode failed (status ${v.status})`);
  }
  throw new Error('encode timed out');
}

async function loadProductLessons(code: string) {
  const product = await prisma.product.findUnique({
    where: { code },
    include: { course: { include: { sections: { include: { lessons: true } } } } },
  });
  if (!product) throw new Error(`product not found: ${code}`);
  const lessons = (product.course?.sections ?? []).flatMap((s) => s.lessons);
  return { product, lessons };
}

async function listMode(): Promise<void> {
  const products = await prisma.product.findMany({
    include: { course: { include: { sections: { include: { lessons: true } } } } },
  });
  const rows: { code: string; title: string; guids: number }[] = [];
  for (const p of products) {
    const lessons = (p.course?.sections ?? []).flatMap((s) => s.lessons);
    const guids = new Set<string>();
    for (const l of lessons) {
      const slides = Array.isArray(l.slidesData) ? (l.slidesData as Slide[]) : [];
      for (const g of guidsInSlides(slides)) guids.add(g);
    }
    if (guids.size > 0) rows.push({ code: p.code ?? '(no code)', title: p.title, guids: guids.size });
  }
  rows.sort((a, b) => a.guids - b.guids);
  console.log(`products with media (${rows.length}), fewest videos first:\n`);
  for (const r of rows.slice(0, 25)) {
    console.log(`  ${String(r.guids).padStart(3)} videos  ${r.code.padEnd(12)}  ${r.title}`);
  }
  await prisma.$disconnect();
}

async function migrateMode(code: string): Promise<void> {
  const { product, lessons } = await loadProductLessons(code);
  console.log(`product: ${product.title}  (code ${product.code})`);

  const allGuids = new Set<string>();
  for (const l of lessons) {
    const slides = Array.isArray(l.slidesData) ? (l.slidesData as Slide[]) : [];
    for (const g of guidsInSlides(slides)) allGuids.add(g);
  }
  console.log(`lessons: ${lessons.length}  distinct guids: ${allGuids.size}`);

  const map = loadMap();
  const toCopy = [...allGuids].filter((g) => !map[g]);
  console.log(`already mapped: ${allGuids.size - toCopy.length}  to copy: ${toCopy.length}`);

  if (!APPLY) {
    console.log('\nDRY-RUN — pass --apply to copy videos + write the DB.');
    await prisma.$disconnect();
    return;
  }

  // 1. Copy any not-yet-mapped videos.
  for (const g of toCopy) {
    process.stdout.write(`  copying ${g} ... `);
    const newGuid = await copyVideo(g);
    map[g] = newGuid;
    saveMap(map);
    console.log(`-> ${newGuid}`);
  }

  // 2. Rewrite each lesson's slidesData.
  let lessonsChanged = 0;
  let slidesChanged = 0;
  for (const l of lessons) {
    const slides = Array.isArray(l.slidesData) ? (l.slidesData as Slide[]) : [];
    const { slides: next, changed } = rewriteSlides(slides, map);
    if (changed > 0) {
      await prisma.lesson.update({ where: { id: l.id }, data: { slidesData: next as object[] } });
      lessonsChanged += 1;
      slidesChanged += changed;
    }
  }
  console.log(`\nDB updated: ${lessonsChanged} lessons, ${slidesChanged} slides rewritten.`);

  // 3. Verify — no slide should still reference the legacy library.
  const fresh = await loadProductLessons(code);
  let stale = 0;
  for (const l of fresh.lessons) {
    const slides = Array.isArray(l.slidesData) ? (l.slidesData as Slide[]) : [];
    for (const s of slides) {
      const d = s?.data ?? {};
      if (typeof d.audio?.videoLibraryId === 'string' && d.audio.videoLibraryId === String(SRC_LIBRARY_ID)) stale += 1;
      if (typeof d.url === 'string' && d.url.includes(`/embed/${SRC_LIBRARY_ID}/`)) stale += 1;
    }
  }
  console.log(stale === 0 ? 'VERIFIED — no legacy-library references remain.' : `WARNING — ${stale} stale references still present.`);

  await prisma.$disconnect();
}

async function main(): Promise<void> {
  if (!ACCOUNT_KEY) {
    console.error('BUNNY_ACCOUNT_API_KEY must be set in .env.');
    process.exit(1);
  }
  if (CODE) await migrateMode(CODE);
  else await listMode();
}

void main().catch((err) => {
  console.error('ERROR:', (err as Error).message);
  process.exit(1);
});
