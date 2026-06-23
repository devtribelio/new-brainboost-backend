/**
 * Migrate the two structured-`data.video` VideoTemplate slides that the main
 * migration (migrate-all-media.ts) skips — its scan only handles the `data.url`
 * iframe video shape, not the `data.video` object shape (which looks like
 * AudioTemplate's `data.audio`).
 *
 *   pnpm exec tsx scripts/migrate-extra-videos.ts            # dry-run
 *   pnpm exec tsx scripts/migrate-extra-videos.ts --apply    # copy + rewrite DB
 *
 * Idempotent: copies are recorded in scripts/media-guid-map.json and skipped on
 * re-run, so `--apply` is safe per environment — the copy is Bunny-side (shared
 * library 666592), the rewrite is per-database.
 *
 * Requires BUNNY_ACCOUNT_API_KEY in .env (only for the copy step).
 *
 * NOTE: the serializer (product.serializer.ts) does not yet emit a streamUrl for
 * the `data.video` shape — these two slides won't play until that is added.
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

/** The two structured-`data.video` guids skipped by the main migration. */
const TARGET_GUIDS = [
  'd40cbd6e-de1f-4cbc-8cf5-668283dcc9ad',
  '49a4552d-b1e4-43a8-a626-f263953aa9cd',
];

const APPLY = process.argv.includes('--apply');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Slide {
  type?: unknown;
  data?: { video?: { guid?: unknown; videoLibraryId?: unknown } };
}

function loadMap(): Record<string, string> {
  return existsSync(MAP_PATH) ? (JSON.parse(readFileSync(MAP_PATH, 'utf8')) as Record<string, string>) : {};
}
function saveMap(m: Record<string, string>): void {
  writeFileSync(MAP_PATH, `${JSON.stringify(m, null, 2)}\n`);
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
async function copyOne(srcGuid: string): Promise<string> {
  const srcKey = await libraryApiKey(SRC_LIBRARY_ID);
  const dstKey = await libraryApiKey(DST_LIBRARY_ID);

  const metaR = await fetch(`${API}/library/${SRC_LIBRARY_ID}/videos/${srcGuid}`, {
    headers: { AccessKey: srcKey, accept: 'application/json' },
  });
  if (metaR.status !== 200) throw new Error(`source lookup -> HTTP ${metaR.status}`);
  const meta = (await metaR.json()) as { title?: string; availableResolutions?: string };
  const res = (meta.availableResolutions ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const rendition = ['720p', '480p', '360p', '240p'].find((o) => res.includes(o));
  if (!rendition) throw new Error(`no MP4 rendition (availableResolutions="${meta.availableResolutions}")`);

  const createR = await fetch(`${API}/library/${DST_LIBRARY_ID}/videos`, {
    method: 'POST',
    headers: { AccessKey: dstKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ title: meta.title || `migrated-${srcGuid}` }),
  });
  if (createR.status !== 200) throw new Error(`create -> HTTP ${createR.status}`);
  const newGuid = String(((await createR.json()) as { guid: string }).guid);

  const deleteNew = async (): Promise<void> => {
    await fetch(`${API}/library/${DST_LIBRARY_ID}/videos/${newGuid}`, {
      method: 'DELETE',
      headers: { AccessKey: dstKey, accept: 'application/json' },
    });
  };

  const fetchR = await fetch(`${API}/library/${DST_LIBRARY_ID}/videos/${newGuid}/fetch`, {
    method: 'POST',
    headers: { AccessKey: dstKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      url: `https://${SRC_CDN}/${srcGuid}/play_${rendition}.mp4`,
      headers: { Referer: REFERER },
    }),
  });
  if (fetchR.status !== 200) {
    await deleteNew();
    throw new Error(`fetch -> HTTP ${fetchR.status}`);
  }

  for (let i = 0; i < 200; i += 1) {
    await sleep(6000);
    const vR = await fetch(`${API}/library/${DST_LIBRARY_ID}/videos/${newGuid}`, {
      headers: { AccessKey: dstKey, accept: 'application/json' },
    });
    if (vR.status !== 200) continue;
    const v = (await vR.json()) as { status?: number };
    if (v.status === 4) return newGuid;
    if (v.status === 5 || v.status === 6) {
      await deleteNew();
      throw new Error(`encode failed (status ${v.status})`);
    }
  }
  await deleteNew();
  throw new Error('encode timed out');
}

async function main(): Promise<void> {
  const map = loadMap();
  const toCopy = TARGET_GUIDS.filter((g) => !map[g]);
  console.log(`target guids: ${TARGET_GUIDS.length}, already copied: ${TARGET_GUIDS.length - toCopy.length}, to copy: ${toCopy.length}`);

  if (!APPLY) {
    console.log('\nDRY-RUN — pass --apply to copy the videos + rewrite the DB.');
    await prisma.$disconnect();
    return;
  }

  // 1. Copy any not-yet-copied videos into library 666592.
  if (toCopy.length > 0 && !ACCOUNT_KEY) {
    console.error('BUNNY_ACCOUNT_API_KEY must be set in .env to copy videos.');
    process.exit(1);
  }
  for (const g of toCopy) {
    process.stdout.write(`  copying ${g} ... `);
    const newGuid = await copyOne(g);
    map[g] = newGuid;
    saveMap(map);
    console.log(`-> ${newGuid}`);
  }

  // 2. Rewrite the DB — VideoTemplate slides with a structured `data.video`.
  const lessons = await prisma.lesson.findMany({ select: { id: true, slidesData: true } });
  let lessonsChanged = 0;
  let slidesChanged = 0;
  for (const l of lessons) {
    const slides = Array.isArray(l.slidesData) ? (l.slidesData as Slide[]) : [];
    const next = structuredClone(slides);
    let changed = 0;
    for (const s of next) {
      const d = s?.data ?? {};
      if (
        s?.type === 'VideoTemplate' &&
        typeof d.video?.guid === 'string' &&
        map[d.video.guid]
      ) {
        d.video.guid = map[d.video.guid];
        d.video.videoLibraryId = String(DST_LIBRARY_ID);
        changed += 1;
      }
    }
    if (changed > 0) {
      await prisma.lesson.update({ where: { id: l.id }, data: { slidesData: next as object[] } });
      lessonsChanged += 1;
      slidesChanged += changed;
    }
  }
  console.log(`\nDB updated: ${lessonsChanged} lessons, ${slidesChanged} slides.`);

  // 3. Verify — no target slide still references the legacy library.
  const fresh = await prisma.lesson.findMany({ select: { slidesData: true } });
  let stale = 0;
  for (const l of fresh) {
    const slides = Array.isArray(l.slidesData) ? (l.slidesData as Slide[]) : [];
    for (const s of slides) {
      const g = s?.data?.video?.guid;
      if (typeof g === 'string' && TARGET_GUIDS.includes(g)) stale += 1;
    }
  }
  console.log(stale === 0 ? 'VERIFIED — both videos migrated.' : `WARNING — ${stale} slide(s) still reference an old guid.`);

  await prisma.$disconnect();
}

void main().catch((err) => {
  console.error('ERROR:', (err as Error).message);
  process.exit(1);
});
