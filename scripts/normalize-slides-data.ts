/* eslint-disable no-console */
/**
 * Lever A — normalize `course_lessons.slides_data` to a lean shape.
 *
 * Media slides currently store the full raw Bunny metadata blob (~27 fields) and
 * the full iframe HTML; only `guid` + duration are ever used. This rewrites every
 * media slide to:
 *
 *   { id, type, name, data: { title, description, guid, durationSec } }          // Bunny
 *   { id, type, name, data: { title, description, url, platform, durationSec } } // external video
 *
 * Non-media slides (Text/Greeting/ThankYou/Document/Image) pass through unchanged.
 * `Lesson.duration` is recomputed as the sum of media `durationSec`.
 *
 *   pnpm exec tsx scripts/normalize-slides-data.ts            # dry-run summary
 *   pnpm exec tsx scripts/normalize-slides-data.ts --sample   # before/after, one per type
 *   pnpm exec tsx scripts/normalize-slides-data.ts --apply    # rewrite slidesData + duration
 *
 * Idempotent: a slide already in lean shape is left as-is (no Bunny re-fetch).
 * Requires BUNNY_ACCOUNT_API_KEY (only for VideoTemplate length lookups).
 */
import 'dotenv/config';
import { prisma } from '@bb/db';

const ACCOUNT_KEY = process.env.BUNNY_ACCOUNT_API_KEY ?? '';
const DEFAULT_LIBRARY_ID = Number.parseInt(process.env.BUNNY_STREAM_LIBRARY_ID ?? '157244', 10);
const API = 'https://video.bunnycdn.com';

const APPLY = process.argv.includes('--apply');
const SAMPLE = process.argv.includes('--sample');

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const EMBED_RE = new RegExp(`iframe\\.mediadelivery\\.net/embed/(\\d+)/(${UUID})`);
const MEDIA_TYPES = new Set(['AudioTemplate', 'VideoTemplate']);

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function toInt(value: unknown): number {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function libIdOf(value: unknown, fallback: number): number {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface RawSlide {
  id?: unknown;
  type?: unknown;
  name?: unknown;
  duration?: unknown;
  data?: Record<string, unknown>;
}
interface LeanData {
  title: unknown;
  description: unknown;
  guid?: string;
  url?: string;
  platform?: string;
  durationSec: number;
}

// ---- Bunny management API (video length only) ----
const apiKeyCache = new Map<number, string>();
const lengthCache = new Map<string, number>();
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
async function videoLength(libraryId: number, guid: string): Promise<number> {
  const cacheKey = `${libraryId}/${guid}`;
  if (lengthCache.has(cacheKey)) return lengthCache.get(cacheKey) as number;
  const key = await libraryApiKey(libraryId);
  const r = await fetch(`${API}/library/${libraryId}/videos/${guid}`, {
    headers: { AccessKey: key, accept: 'application/json' },
  });
  if (r.status !== 200) {
    log(`  ! ${cacheKey} -> HTTP ${r.status}`);
    return 0;
  }
  const len = toInt(((await r.json()) as { length?: number }).length);
  lengthCache.set(cacheKey, len);
  return len;
}

/** True when a slide is already in the lean shape (skip re-fetch). */
function isLean(slide: RawSlide): boolean {
  const d = slide.data ?? {};
  return (
    typeof d.durationSec === 'number' && !('audio' in d) && (!('url' in d) || typeof d.guid !== 'string')
  );
}

/**
 * Transform one slide. Returns the (possibly) rewritten slide; non-media and
 * already-lean slides are returned unchanged.
 */
async function leanSlide(slide: RawSlide): Promise<RawSlide> {
  const type = typeof slide.type === 'string' ? slide.type : '';
  if (!MEDIA_TYPES.has(type) || isLean(slide)) return slide;

  const d = slide.data ?? {};
  const base = { id: slide.id, type: slide.type, name: slide.name };

  if (type === 'AudioTemplate') {
    const a = (d.audio ?? {}) as Record<string, unknown>;
    const guid = typeof a.guid === 'string' ? a.guid : undefined;
    // Bunny stores the real duration as `length` right in the audio blob.
    let durationSec = toInt(a.length) || toInt(slide.duration);
    if (!durationSec && guid) durationSec = await videoLength(libIdOf(a.videoLibraryId, DEFAULT_LIBRARY_ID), guid);
    const data: LeanData = { title: d.title ?? null, description: d.description ?? null, durationSec };
    if (guid) data.guid = guid;
    return { ...base, data: data as unknown as Record<string, unknown> };
  }

  // VideoTemplate
  const embed = typeof d.url === 'string' ? EMBED_RE.exec(d.url) : null;
  const structured = (d.video ?? null) as Record<string, unknown> | null;
  if (embed) {
    const [, lib, guid] = embed;
    const durationSec = (await videoLength(Number.parseInt(lib, 10), guid)) || toInt(d.duration) || toInt(slide.duration);
    const data: LeanData = { title: d.title ?? null, description: d.description ?? null, guid, durationSec };
    return { ...base, data: data as unknown as Record<string, unknown> };
  }
  if (structured && typeof structured.guid === 'string') {
    const guid = structured.guid;
    // The structured blob carries the real Bunny `length` (like audio) — trust it
    // first; the management API is a fallback only (and some guids 404 there).
    let durationSec = toInt(structured.length) || toInt(d.duration) || toInt(slide.duration);
    if (!durationSec) durationSec = await videoLength(libIdOf(structured.videoLibraryId, DEFAULT_LIBRARY_ID), guid);
    const data: LeanData = { title: d.title ?? null, description: d.description ?? null, guid, durationSec };
    return { ...base, data: data as unknown as Record<string, unknown> };
  }
  // External (YouTube/etc) — no Bunny guid; keep the url, drop nothing else of value.
  const data: LeanData = {
    title: d.title ?? null,
    description: d.description ?? null,
    durationSec: toInt(slide.duration) || toInt(d.duration),
  };
  if (typeof d.url === 'string') data.url = d.url;
  if (typeof d.platform === 'string') data.platform = d.platform;
  return { ...base, data: data as unknown as Record<string, unknown> };
}

async function transformSlides(raw: unknown): Promise<{ slides: RawSlide[]; lessonDuration: number }> {
  const slides = Array.isArray(raw) ? (raw as RawSlide[]) : [];
  const out: RawSlide[] = [];
  let lessonDuration = 0;
  for (const s of slides) {
    const lean = await leanSlide(s);
    out.push(lean);
    const type = typeof lean.type === 'string' ? lean.type : '';
    if (MEDIA_TYPES.has(type)) lessonDuration += toInt((lean.data as LeanData | undefined)?.durationSec);
  }
  return { slides: out, lessonDuration };
}

// ---- sample mode: one before/after per slide type ----
async function runSample(): Promise<void> {
  const lessons = await prisma.lesson.findMany({ select: { slidesData: true } });
  const seen = new Map<string, RawSlide>();
  const variants = new Map<string, RawSlide>(); // distinguish video shapes
  for (const l of lessons) {
    const slides = Array.isArray(l.slidesData) ? (l.slidesData as RawSlide[]) : [];
    for (const s of slides) {
      const type = typeof s.type === 'string' ? s.type : '?';
      if (!seen.has(type)) seen.set(type, s);
      const d = s.data ?? {};
      if (type === 'VideoTemplate') {
        const key = typeof d.url === 'string' && EMBED_RE.test(d.url)
          ? 'VideoTemplate(iframe-bunny)'
          : d.video
            ? 'VideoTemplate(structured)'
            : typeof d.url === 'string'
              ? 'VideoTemplate(external)'
              : 'VideoTemplate(other)';
        if (!variants.has(key)) variants.set(key, s);
      }
    }
  }
  const picks = new Map<string, RawSlide>([...seen, ...variants]);
  for (const [label, slide] of picks) {
    const before = JSON.stringify(slide);
    const after = await leanSlide(slide);
    const afterStr = JSON.stringify(after, null, 2);
    console.log(`\n================= ${label} =================`);
    console.log(`BEFORE (${before.length} bytes):\n${JSON.stringify(slide, null, 2)}`);
    console.log(`\nAFTER  (${JSON.stringify(after).length} bytes):\n${afterStr}`);
  }
  await prisma.$disconnect();
}

async function runMigration(): Promise<void> {
  const lessons = await prisma.lesson.findMany({ select: { id: true, name: true, duration: true, slidesData: true } });
  log(`mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}  |  lessons: ${lessons.length}`);

  let beforeBytes = 0;
  let afterBytes = 0;
  let changedLessons = 0;
  const updates: { id: string; slidesData: RawSlide[]; duration: number }[] = [];

  for (const l of lessons) {
    beforeBytes += JSON.stringify(l.slidesData ?? null).length;
    const { slides, lessonDuration } = await transformSlides(l.slidesData);
    afterBytes += JSON.stringify(slides).length;
    const slidesChanged = JSON.stringify(slides) !== JSON.stringify(l.slidesData);
    const durationChanged = lessonDuration !== l.duration;
    if (slidesChanged || durationChanged) {
      changedLessons += 1;
      updates.push({ id: l.id, slidesData: slides, duration: lessonDuration });
    }
  }

  log(`slidesData bytes: ${beforeBytes} -> ${afterBytes}  (-${Math.round((1 - afterBytes / beforeBytes) * 100)}%)`);
  log(`lessons to update: ${changedLessons}`);

  if (!APPLY) {
    log('dry-run — no writes. Re-run with --apply to persist, or --sample for examples.');
  } else {
    let n = 0;
    for (const u of updates) {
      await prisma.lesson.update({
        where: { id: u.id },
        data: { slidesData: u.slidesData as unknown as object, duration: u.duration },
      });
      n += 1;
      if (n % 50 === 0) log(`updated ${n}/${updates.length}`);
    }
    log(`DB updated: ${updates.length} lessons.`);
  }
  await prisma.$disconnect();
}

async function main(): Promise<void> {
  if (!ACCOUNT_KEY) {
    console.error('BUNNY_ACCOUNT_API_KEY must be set in .env.');
    process.exit(1);
  }
  if (SAMPLE) await runSample();
  else await runMigration();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
