/**
 * Full media migration — copy ALL course videos from the legacy Bunny library
 * (157244) to the Model C library (666592) and rewrite Lesson.slidesData.
 *
 * Phased and resumable. The old->new guid map persists in
 * `scripts/media-guid-map.json`; every copied video is recorded there
 * immediately, so an interrupted run resumes where it stopped.
 *
 *   pnpm exec tsx scripts/migrate-all-media.ts status            # progress
 *   pnpm exec tsx scripts/migrate-all-media.ts copy              # phase 1 dry-run
 *   pnpm exec tsx scripts/migrate-all-media.ts copy --apply      # phase 1: copy videos
 *   pnpm exec tsx scripts/migrate-all-media.ts rewrite           # phase 2 dry-run
 *   pnpm exec tsx scripts/migrate-all-media.ts rewrite --apply   # phase 2: rewrite DB
 *
 * Order: run `copy --apply` to completion, re-run until 0 failures, THEN
 * `rewrite --apply`. The two phases are independent and safe to repeat.
 *
 * Requires BUNNY_ACCOUNT_API_KEY in .env. Does NOT delete anything in 157244.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { prisma } from '../src/config/prisma';

const ACCOUNT_KEY = process.env.BUNNY_ACCOUNT_API_KEY ?? '';
const REFERER = process.env.BUNNY_REFERER || 'https://brainboost.id';
const SRC_LIBRARY_ID = 157244;
const SRC_CDN = 'vz-5439ef3e-878.b-cdn.net';
const DST_LIBRARY_ID = 666592;
const API = 'https://video.bunnycdn.com';
const MAP_PATH = 'scripts/media-guid-map.json';

/** How many videos to copy/encode concurrently. */
const CHUNK = 8;
/** Per-video encode poll timeout (600 × 6s = 60 min — covers long videos). */
const POLL_ATTEMPTS = 600;
const POLL_INTERVAL_MS = 6000;

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const EMBED_RE = new RegExp(`(iframe\\.mediadelivery\\.net/embed/)(\\d+)(/)(${UUID})`, 'g');

const args = process.argv.slice(2);
const PHASE = args[0] ?? 'status';
const APPLY = args.includes('--apply');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Slide {
  type?: unknown;
  data?: { url?: unknown; audio?: { guid?: unknown; videoLibraryId?: unknown } };
}

// ---- guid map (persistent, resumable) ----
function loadMap(): Record<string, string> {
  return existsSync(MAP_PATH) ? (JSON.parse(readFileSync(MAP_PATH, 'utf8')) as Record<string, string>) : {};
}
function saveMap(m: Record<string, string>): void {
  writeFileSync(MAP_PATH, `${JSON.stringify(m, null, 2)}\n`);
}

// ---- DB scan ----
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

async function allDistinctGuids(): Promise<string[]> {
  const lessons = await prisma.lesson.findMany({ select: { slidesData: true } });
  const set = new Set<string>();
  for (const l of lessons) {
    const slides = Array.isArray(l.slidesData) ? (l.slidesData as Slide[]) : [];
    for (const g of guidsInSlides(slides)) set.add(g);
  }
  return [...set].sort();
}

// ---- Bunny API ----
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

/** Highest available MP4 rendition of a source video, e.g. "720p". */
async function bestRendition(srcKey: string, srcGuid: string): Promise<string> {
  const r = await fetch(`${API}/library/${SRC_LIBRARY_ID}/videos/${srcGuid}`, {
    headers: { AccessKey: srcKey, accept: 'application/json' },
  });
  if (r.status !== 200) throw new Error(`source lookup -> HTTP ${r.status}`);
  const v = (await r.json()) as { availableResolutions?: string; title?: string };
  const res = (v.availableResolutions ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const order = ['720p', '480p', '360p', '240p'];
  const pick = order.find((o) => res.includes(o));
  if (!pick) throw new Error(`no MP4 rendition (availableResolutions="${v.availableResolutions}")`);
  return pick;
}

async function sourceTitle(srcKey: string, srcGuid: string): Promise<string> {
  const r = await fetch(`${API}/library/${SRC_LIBRARY_ID}/videos/${srcGuid}`, {
    headers: { AccessKey: srcKey, accept: 'application/json' },
  });
  if (r.status !== 200) return `migrated-${srcGuid}`;
  return String(((await r.json()) as { title?: string }).title ?? `migrated-${srcGuid}`);
}

/** Copy one source guid into 666592, wait for encode, return the new guid. */
async function copyOne(srcGuid: string): Promise<string> {
  const srcKey = await libraryApiKey(SRC_LIBRARY_ID);
  const dstKey = await libraryApiKey(DST_LIBRARY_ID);

  const rendition = await bestRendition(srcKey, srcGuid);
  const title = await sourceTitle(srcKey, srcGuid);

  const createR = await fetch(`${API}/library/${DST_LIBRARY_ID}/videos`, {
    method: 'POST',
    headers: { AccessKey: dstKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ title }),
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

  for (let i = 0; i < POLL_ATTEMPTS; i += 1) {
    await sleep(POLL_INTERVAL_MS);
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

// ---- slide rewrite ----
function rewriteSlides(
  slides: Slide[],
  map: Record<string, string>,
  newGuids: Set<string>,
): { slides: Slide[]; changed: number } {
  let changed = 0;
  const next = structuredClone(slides);
  for (const s of next) {
    const type = typeof s?.type === 'string' ? s.type : '';
    const d = s?.data ?? {};
    if (type === 'AudioTemplate' && typeof d.audio?.guid === 'string') {
      const g = d.audio.guid;
      if (map[g]) {
        d.audio.guid = map[g];
        d.audio.videoLibraryId = String(DST_LIBRARY_ID);
        changed += 1;
      } else if (newGuids.has(g) && String(d.audio.videoLibraryId ?? '') !== String(DST_LIBRARY_ID)) {
        // guid already migrated but videoLibraryId left stale — normalize it
        d.audio.videoLibraryId = String(DST_LIBRARY_ID);
        changed += 1;
      }
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

// ---- phases ----
async function phaseStatus(): Promise<void> {
  const guids = await allDistinctGuids();
  const map = loadMap();
  const newGuids = new Set(Object.values(map));
  const done = guids.filter((g) => newGuids.has(g)).length;
  const copiedPending = guids.filter((g) => map[g]).length;
  const todo = guids.filter((g) => !map[g] && !newGuids.has(g)).length;
  console.log(`distinct guids in DB:          ${guids.length}`);
  console.log(`already migrated (now 666592): ${done}`);
  console.log(`copied, DB rewrite pending:    ${copiedPending}`);
  console.log(`still to copy:                 ${todo}`);
}

async function phaseCopy(): Promise<void> {
  if (!ACCOUNT_KEY) {
    console.error('BUNNY_ACCOUNT_API_KEY must be set in .env for the copy phase.');
    process.exit(1);
  }
  const guids = await allDistinctGuids();
  const map = loadMap();
  const newGuids = new Set(Object.values(map));
  // Skip guids already copied (map keys) and guids that are themselves already
  // migrated 666592 guids (a product rewritten in an earlier run).
  const todo = guids.filter((g) => !map[g] && !newGuids.has(g));
  console.log(`${guids.length} guids in DB, ${guids.length - todo.length} already done, ${todo.length} to copy.`);

  if (!APPLY) {
    console.log('DRY-RUN — pass --apply to copy. Videos copy/encode in chunks of', CHUNK);
    return;
  }

  const failures: { guid: string; error: string }[] = [];
  for (let i = 0; i < todo.length; i += CHUNK) {
    const chunk = todo.slice(i, i + CHUNK);
    console.log(`\nchunk ${i / CHUNK + 1} — copying ${chunk.length} (${i + chunk.length}/${todo.length})`);
    const results = await Promise.allSettled(chunk.map((g) => copyOne(g)));
    results.forEach((res, idx) => {
      const guid = chunk[idx];
      if (res.status === 'fulfilled') {
        map[guid] = res.value;
        saveMap(map);
        console.log(`  ok   ${guid} -> ${res.value}`);
      } else {
        failures.push({ guid, error: String(res.reason?.message ?? res.reason) });
        console.log(`  FAIL ${guid}: ${res.reason?.message ?? res.reason}`);
      }
    });
  }

  console.log(`\ncopy phase done. mapped ${Object.keys(map).length}, failures ${failures.length}.`);
  if (failures.length) {
    writeFileSync('scripts/media-copy-failures.json', `${JSON.stringify(failures, null, 2)}\n`);
    console.log('failures -> scripts/media-copy-failures.json — re-run `copy --apply` to retry.');
  }
}

async function phaseRewrite(): Promise<void> {
  const map = loadMap();
  if (Object.keys(map).length === 0) {
    console.log('guid map is empty — run the copy phase first.');
    return;
  }
  const newGuids = new Set(Object.values(map));
  const lessons = await prisma.lesson.findMany({ select: { id: true, slidesData: true } });

  let lessonsToChange = 0;
  let slidesToChange = 0;
  const updates: { id: string; slides: Slide[] }[] = [];
  for (const l of lessons) {
    const slides = Array.isArray(l.slidesData) ? (l.slidesData as Slide[]) : [];
    const { slides: next, changed } = rewriteSlides(slides, map, newGuids);
    if (changed > 0) {
      lessonsToChange += 1;
      slidesToChange += changed;
      updates.push({ id: l.id, slides: next });
    }
  }
  console.log(`${lessonsToChange} lessons / ${slidesToChange} slides to rewrite.`);

  if (!APPLY) {
    console.log('DRY-RUN — pass --apply to write the DB.');
    return;
  }
  for (const u of updates) {
    await prisma.lesson.update({ where: { id: u.id }, data: { slidesData: u.slides as object[] } });
  }
  console.log(`DB updated: ${updates.length} lessons.`);

  // verify
  const fresh = await prisma.lesson.findMany({ select: { slidesData: true } });
  let stale = 0;
  for (const l of fresh) {
    const slides = Array.isArray(l.slidesData) ? (l.slidesData as Slide[]) : [];
    for (const s of slides) {
      const d = s?.data ?? {};
      if (String(d.audio?.videoLibraryId ?? '') === String(SRC_LIBRARY_ID)) stale += 1;
      if (typeof d.url === 'string' && d.url.includes(`/embed/${SRC_LIBRARY_ID}/`)) stale += 1;
    }
  }
  console.log(
    stale === 0
      ? 'VERIFIED — no legacy-library references remain.'
      : `NOTE — ${stale} slide(s) still reference library ${SRC_LIBRARY_ID} (their videos were not copied).`,
  );
}

async function main(): Promise<void> {
  if (PHASE === 'copy') await phaseCopy();
  else if (PHASE === 'rewrite') await phaseRewrite();
  else if (PHASE === 'status') await phaseStatus();
  else console.error(`unknown phase "${PHASE}" — use: status | copy | rewrite`);
  await prisma.$disconnect();
}

void main().catch((err) => {
  console.error('ERROR:', (err as Error).message);
  process.exit(1);
});
