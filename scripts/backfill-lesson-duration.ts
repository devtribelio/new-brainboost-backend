/* eslint-disable no-console */
/**
 * Backfill `course_lessons.duration` from the REAL Bunny Stream video length.
 *
 * `Lesson.duration` (seconds) currently carries the legacy value (often 0). Each
 * media slide in `slidesData` references a Bunny video; Bunny's management API
 * exposes the true encoded length. This script sums the length of every media
 * slide in a lesson and writes it to `Lesson.duration`.
 *
 *   pnpm exec tsx scripts/backfill-lesson-duration.ts          # dry-run (no writes)
 *   pnpm exec tsx scripts/backfill-lesson-duration.ts --apply  # persist durations
 *
 * Idempotent: re-running only writes lessons whose computed duration differs
 * from what is stored. Read-only on Bunny. Requires BUNNY_ACCOUNT_API_KEY in .env
 * (used to resolve a per-library management key, like the media-migration scripts).
 *
 * Slide shapes handled (mirrors product.serializer / scan-media-guids):
 *   - AudioTemplate  -> data.audio.guid     (+ data.audio.videoLibraryId)
 *   - VideoTemplate  -> data.url iframe      (lib + guid in mediadelivery embed)
 *   - VideoTemplate  -> data.video.guid     (+ data.video.videoLibraryId, structured)
 */
import 'dotenv/config';
import { prisma } from '@bb/db';

const ACCOUNT_KEY = process.env.BUNNY_ACCOUNT_API_KEY ?? '';
const DEFAULT_LIBRARY_ID = Number.parseInt(process.env.BUNNY_STREAM_LIBRARY_ID ?? '157244', 10);
const API = 'https://video.bunnycdn.com';
/** Distinct videos fetched concurrently against the Bunny management API. */
const CHUNK = 10;

const APPLY = process.argv.includes('--apply');

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const EMBED_RE = new RegExp(`iframe\\.mediadelivery\\.net/embed/(\\d+)/(${UUID})`, 'g');

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

interface MediaRef {
  guid: string;
  libraryId: number;
}
interface Slide {
  type?: unknown;
  data?: {
    url?: unknown;
    audio?: { guid?: unknown; videoLibraryId?: unknown };
    video?: { guid?: unknown; videoLibraryId?: unknown };
  };
}

/** A stable cache key — a guid is only unique within its library. */
const refKey = (r: MediaRef): string => `${r.libraryId}/${r.guid}`;

function libIdOf(value: unknown, fallback: number): number {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Extract every Bunny media reference from a lesson's slidesData. */
function refsInSlides(raw: unknown): MediaRef[] {
  const slides = Array.isArray(raw) ? (raw as Slide[]) : [];
  const out: MediaRef[] = [];
  for (const slide of slides) {
    const type = typeof slide?.type === 'string' ? slide.type : '';
    const d = slide?.data ?? {};

    if (type === 'AudioTemplate' && typeof d.audio?.guid === 'string') {
      out.push({ guid: d.audio.guid, libraryId: libIdOf(d.audio.videoLibraryId, DEFAULT_LIBRARY_ID) });
    } else if (type === 'VideoTemplate') {
      if (typeof d.url === 'string') {
        for (const m of d.url.matchAll(EMBED_RE)) {
          out.push({ guid: m[2], libraryId: libIdOf(m[1], DEFAULT_LIBRARY_ID) });
        }
      } else if (typeof d.video?.guid === 'string') {
        out.push({ guid: d.video.guid, libraryId: libIdOf(d.video.videoLibraryId, DEFAULT_LIBRARY_ID) });
      }
    }
  }
  return out;
}

// ---- Bunny management API ----
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

/** Real encoded duration (seconds) of a Bunny video, or null if unavailable. */
async function fetchVideoLength(ref: MediaRef): Promise<number | null> {
  const key = await libraryApiKey(ref.libraryId);
  const r = await fetch(`${API}/library/${ref.libraryId}/videos/${ref.guid}`, {
    headers: { AccessKey: key, accept: 'application/json' },
  });
  if (r.status !== 200) {
    log(`  ! ${refKey(ref)} -> HTTP ${r.status}`);
    return null;
  }
  const v = (await r.json()) as { length?: number };
  return typeof v.length === 'number' && v.length > 0 ? Math.round(v.length) : null;
}

async function main(): Promise<void> {
  if (!ACCOUNT_KEY) {
    console.error('BUNNY_ACCOUNT_API_KEY must be set in .env.');
    process.exit(1);
  }
  log(`mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}`);

  const lessons = await prisma.lesson.findMany({
    select: { id: true, name: true, duration: true, slidesData: true },
  });
  log(`lessons total: ${lessons.length}`);

  // Pass 1 — collect refs per lesson + the distinct video work-list.
  const lessonRefs = new Map<string, MediaRef[]>();
  const distinct = new Map<string, MediaRef>();
  for (const l of lessons) {
    const refs = refsInSlides(l.slidesData);
    if (refs.length === 0) continue;
    lessonRefs.set(l.id, refs);
    for (const r of refs) distinct.set(refKey(r), r);
  }
  log(`lessons with media: ${lessonRefs.size}  |  distinct videos: ${distinct.size}`);

  // Fetch each distinct video's length once, with bounded concurrency.
  const lengthByKey = new Map<string, number>();
  const work = [...distinct.values()];
  let failed = 0;
  for (let i = 0; i < work.length; i += CHUNK) {
    const chunk = work.slice(i, i + CHUNK);
    const results = await Promise.all(chunk.map((r) => fetchVideoLength(r)));
    results.forEach((len, j) => {
      if (len === null) failed += 1;
      else lengthByKey.set(refKey(chunk[j]), len);
    });
    log(`fetched ${Math.min(i + chunk.length, work.length)}/${work.length} videos`);
  }
  log(`video lengths resolved: ${lengthByKey.size}  |  failed lookups: ${failed}`);

  // Pass 2 — sum per lesson, compare, (optionally) write.
  let changed = 0;
  let unchanged = 0;
  let partial = 0;
  const updates: { id: string; duration: number }[] = [];
  for (const l of lessons) {
    const refs = lessonRefs.get(l.id);
    if (!refs) continue;
    let sum = 0;
    let missing = false;
    for (const r of refs) {
      const len = lengthByKey.get(refKey(r));
      if (len === undefined) missing = true;
      else sum += len;
    }
    if (missing) partial += 1; // some video failed lookup — skip to avoid a wrong total
    else if (sum === l.duration) unchanged += 1;
    else {
      changed += 1;
      updates.push({ id: l.id, duration: sum });
      if (changed <= 20) log(`  ~ ${l.name}: ${l.duration}s -> ${sum}s`);
    }
  }

  log(`\nsummary: ${changed} to update, ${unchanged} already correct, ${partial} skipped (failed lookup)`);

  if (!APPLY) {
    log('dry-run — no DB writes. Re-run with --apply to persist.');
  } else if (updates.length > 0) {
    await prisma.$transaction(
      updates.map((u) => prisma.lesson.update({ where: { id: u.id }, data: { duration: u.duration } })),
    );
    log(`DB updated: ${updates.length} lessons.`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
