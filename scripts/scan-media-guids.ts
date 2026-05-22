/**
 * Fase 0 — inventory. Scans every Lesson.slidesData for the Bunny Stream guids
 * in use (AudioTemplate `data.audio.guid` + VideoTemplate iframe in `data.url`).
 *
 * Read-only on the DB. Writes the distinct-guid work list to
 * `scripts/media-guids.json` — input for the content-migration phase.
 *
 * Run: pnpm exec tsx scripts/scan-media-guids.ts
 */
import { writeFileSync } from 'node:fs';
import { prisma } from '../src/config/prisma';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const EMBED_RE = new RegExp(`iframe\\.mediadelivery\\.net/embed/(\\d+)/(${UUID})`);

interface SlideData {
  url?: unknown;
  audio?: { guid?: unknown; videoLibraryId?: unknown };
}
interface Slide {
  type?: unknown;
  data?: SlideData;
}
interface Entry {
  guid: string;
  libraryId: string;
  kind: 'audio' | 'video';
  refCount: number;
}

async function main(): Promise<void> {
  const lessons = await prisma.lesson.findMany({ select: { id: true, slidesData: true } });

  const byGuid = new Map<string, Entry>();
  let lessonsWithMedia = 0;
  let audioSlides = 0;
  let videoSlides = 0;
  let unparsableVideo = 0;

  for (const lesson of lessons) {
    const slides = Array.isArray(lesson.slidesData) ? (lesson.slidesData as Slide[]) : [];
    let hasMedia = false;

    for (const slide of slides) {
      const type = typeof slide?.type === 'string' ? slide.type : '';
      const d = slide?.data ?? {};

      if (type === 'AudioTemplate' && d.audio && typeof d.audio.guid === 'string') {
        hasMedia = true;
        audioSlides += 1;
        const guid = d.audio.guid;
        const lib = String(d.audio.videoLibraryId ?? '');
        const e = byGuid.get(guid) ?? { guid, libraryId: lib, kind: 'audio' as const, refCount: 0 };
        e.refCount += 1;
        byGuid.set(guid, e);
      } else if (type === 'VideoTemplate' && typeof d.url === 'string') {
        hasMedia = true;
        videoSlides += 1;
        const m = d.url.match(EMBED_RE);
        if (m) {
          const [, lib, guid] = m;
          const e = byGuid.get(guid) ?? { guid, libraryId: lib, kind: 'video' as const, refCount: 0 };
          e.refCount += 1;
          byGuid.set(guid, e);
        } else {
          unparsableVideo += 1;
        }
      }
    }
    if (hasMedia) lessonsWithMedia += 1;
  }

  const entries = [...byGuid.values()].sort((a, b) => a.guid.localeCompare(b.guid));
  const byLibrary = new Map<string, number>();
  for (const e of entries) byLibrary.set(e.libraryId, (byLibrary.get(e.libraryId) ?? 0) + 1);

  console.log(`lessons total:            ${lessons.length}`);
  console.log(`lessons with media:       ${lessonsWithMedia}`);
  console.log(`audio slides:             ${audioSlides}`);
  console.log(`video slides:             ${videoSlides}`);
  console.log(`video slides unparsable:  ${unparsableVideo}  (external / non-Bunny)`);
  console.log(`distinct Bunny guids:     ${entries.length}`);
  console.log('by library id:');
  for (const [lib, n] of byLibrary) console.log(`  ${lib || '(none)'}: ${n}`);

  writeFileSync('scripts/media-guids.json', `${JSON.stringify(entries, null, 2)}\n`);
  console.log(`\nwork list -> scripts/media-guids.json  (${entries.length} videos to migrate)`);

  await prisma.$disconnect();
}

void main().catch((err) => {
  console.error('ERROR:', (err as Error).message);
  process.exit(1);
});
