import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';
import { prisma } from '@bb/db';
import { env } from '@bb/common/config/env';
import { logger } from '@bb/common/config/logger';
import { S3StorageService, s3StorageService } from '@bb/common/services/s3-storage.service';
import { signBunnyMp4Url } from './bunny-sign.util';
import { parseHlsParts, segmentSeconds } from './audio-migration.util';

const run = promisify(execFile);

export const MIGRATION_STATUS = {
  REQUESTED: 'REQUESTED',
  PROCESSING: 'PROCESSING',
  DONE: 'DONE',
  FAILED: 'FAILED',
} as const;

/** A task killed mid-run leaves PROCESSING behind; past this it is retried. */
const STALE_MINUTES = 30;
const MAX_ATTEMPTS = 3;
/**
 * Stop CLAIMING new work after this long. The lane fires every 5 minutes and
 * PM2's `cron_restart` kills a process that is still running at the next tick,
 * so the job must be idle before then. One asset is ~1 minute.
 */
const BUDGET_MS = 3 * 60 * 1000;
/** Audio is byte-identical at 360p and 480p (134 kbps); take the smallest file that exists. */
const RESOLUTIONS = ['360p', '480p', '720p', '240p'];
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** The only place a job may read a master from. The key comes from a DB row the
 * backoffice wrote, so it is checked rather than trusted. */
export const UPLOAD_PREFIX = 'private/audio-uploads/';

/**
 * Background job: move requested audio assets from Bunny to our own storage.
 *
 * The backoffice only INSERTs a `media_audio_migration_jobs` row; everything
 * that needs ffmpeg, the Bunny token key or S3 credentials happens here (same
 * split as `executeApprovedDisbursements`). Per job: download the Bunny MP4 (or,
 * for a backoffice upload, the master at `source_key` in our own bucket),
 * copy the AAC track out WITHOUT re-encoding, cut it into ≤ `parts` MPEG-TS
 * files, upload under a fresh `private/audio/<guid>/<version>/`, verify, then
 * upsert `media_audio_sources` ACTIVE — from that moment `/media/hls` serves the
 * asset from our storage. Rollback stays `is_active = false`, no deploy.
 *
 * A failure is terminal for that job (FAILED + message); the button creates a
 * new one. Only a job that DIED (stale PROCESSING) is retried by itself.
 */
export async function migrateAudioToStorage(
  storage: S3StorageService = s3StorageService,
): Promise<{ done: number; failed: number; requeued: number }> {
  const requeued = await requeueStale();
  const deadline = Date.now() + BUDGET_MS;
  let done = 0;
  let failed = 0;

  while (Date.now() < deadline) {
    const next = await prisma.mediaAudioMigrationJob.findFirst({
      where: { status: MIGRATION_STATUS.REQUESTED },
      orderBy: { requestedAt: 'asc' },
    });
    if (!next) break;

    // Claim: a second lane (or an overlapping tick) loses here and moves on.
    const claimed = await prisma.mediaAudioMigrationJob.updateMany({
      where: { id: next.id, status: MIGRATION_STATUS.REQUESTED },
      data: { status: MIGRATION_STATUS.PROCESSING, startedAt: new Date(), attempts: { increment: 1 }, error: null },
    });
    if (claimed.count === 0) continue;

    try {
      const result = await migrateOne(next.guid, next.parts, next.lessonId, next.sourceKey, storage);
      await prisma.mediaAudioMigrationJob.update({
        where: { id: next.id },
        data: { status: MIGRATION_STATUS.DONE, finishedAt: new Date() },
      });
      done += 1;
      logger.info({ jobId: next.id, guid: next.guid, ...result }, '[jobs] audio migrated to storage');
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      await prisma.mediaAudioMigrationJob.update({
        where: { id: next.id },
        data: { status: MIGRATION_STATUS.FAILED, finishedAt: new Date(), error: message.slice(0, 1000) },
      });
      logger.error({ jobId: next.id, guid: next.guid, err }, '[jobs] audio migration failed');
    }
  }

  if (done + failed + requeued > 0) {
    logger.info({ done, failed, requeued }, '[jobs] migrateAudioToStorage done');
  }
  return { done, failed, requeued };
}

async function requeueStale(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000);
  const gaveUp = await prisma.mediaAudioMigrationJob.updateMany({
    where: { status: MIGRATION_STATUS.PROCESSING, startedAt: { lt: cutoff }, attempts: { gte: MAX_ATTEMPTS } },
    data: { status: MIGRATION_STATUS.FAILED, finishedAt: new Date(), error: `Terhenti ${MAX_ATTEMPTS}x sebelum selesai` },
  });
  const retried = await prisma.mediaAudioMigrationJob.updateMany({
    where: { status: MIGRATION_STATUS.PROCESSING, startedAt: { lt: cutoff } },
    data: { status: MIGRATION_STATUS.REQUESTED },
  });
  if (gaveUp.count > 0) logger.warn({ count: gaveUp.count }, '[jobs] audio migration gave up on stale jobs');
  return retried.count;
}

async function migrateOne(
  guid: string,
  parts: number,
  lessonId: string | null,
  sourceKey: string | null,
  storage: S3StorageService,
): Promise<{ version: number; parts: number; durationSec: number; bytes: number; res: string }> {
  if (sourceKey !== null && (!sourceKey.startsWith(`${UPLOAD_PREFIX}${guid}/`) || sourceKey.includes('..'))) {
    throw new Error('source_key di luar folder unggahan audio ini');
  }
  const work = await mkdtemp(join(tmpdir(), 'bb-audio-'));
  try {
    // ffmpeg sniffs the container, so the local name needs no real extension.
    const src = join(work, 'source.bin');
    let res = 'upload';
    if (sourceKey) await storage.downloadToFile(sourceKey, src);
    else res = await downloadBunnyMp4(guid, src);

    // Copy the track when it is already AAC (it always is on Bunny); never
    // re-encode spoken word for nothing. ADTS = self-describing, no EXT-X-MAP.
    const codec = (await ffprobe(['-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', src])).split('\n')[0];
    if (!codec) throw new Error('File sumber tidak punya track audio');
    const full = join(work, 'full.aac');
    const audioArgs = codec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k'];
    await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vn', ...audioArgs, '-f', 'adts', full], { maxBuffer: 1 << 20 });

    // Length for PLANNING the cut comes from the source container (mp4/mp3/wav
    // carry a real duration). Never from `full`: ADTS has no duration field, so
    // ffprobe guesses it from the bitrate and lands ~5% long — enough to make the
    // last part a stub. The length we STORE is summed from the cut parts below,
    // which the muxer takes from packet timestamps.
    const probe = (f: string) => ffprobe(['-show_entries', 'format=duration', '-of', 'csv=p=0', f]).then(Number.parseFloat);
    const srcSec = await probe(src);
    const planSec = srcSec > 0 ? srcSec : await probe(full);
    const bytes = (await stat(full)).size;
    if (!(planSec > 0)) throw new Error('Durasi hasil 0 detik — sumber tidak valid');
    if (bytes < 100_000) throw new Error(`Hasil terlalu kecil (${bytes} byte) — sumber tidak valid`);
    const sha256 = await sha256Of(full);

    const partsDir = join(work, 'parts');
    await run('mkdir', ['-p', partsDir]);
    await run(
      'ffmpeg',
      ['-v', 'error', '-y', '-i', full, '-c:a', 'copy', '-f', 'hls',
        '-hls_time', String(segmentSeconds(planSec, parts)),
        '-hls_playlist_type', 'vod', '-hls_list_size', '0',
        '-hls_segment_filename', join(partsDir, '%03d.ts'), join(partsDir, 'index.m3u8')],
      { maxBuffer: 1 << 20 },
    );
    const cut = parseHlsParts(await readFile(join(partsDir, 'index.m3u8'), 'utf8'));
    if (cut.length === 0 || cut.length > parts) {
      throw new Error(`Pemotongan menghasilkan ${cut.length} bagian (maks ${parts})`);
    }
    const durationSec = Math.round(cut.reduce((sum, p) => sum + p.durationSec, 0));

    // Never write into a prefix that holds anything: those keys are served
    // `immutable`, so reusing one would leave the CDN and the bucket disagreeing.
    const existing = await prisma.mediaAudioSource.findUnique({ where: { guid }, select: { version: true } });
    let version = (existing?.version ?? 0) + 1;
    while (await storage.prefixExists(`private/audio/${guid}/${version}/`)) version += 1;
    const prefix = `private/audio/${guid}/${version}`;

    const segments: Array<{ key: string; durationSec: number; bytes: number }> = [];
    for (const p of cut) {
      const body = await readFile(join(partsDir, p.file));
      const key = `${prefix}/${p.file}`;
      await storage.putObject({ key, body, contentType: 'video/mp2t', cacheControl: IMMUTABLE });
      segments.push({ key, durationSec: p.durationSec, bytes: body.length });
    }
    for (const key of [segments[0].key, segments[segments.length - 1].key]) {
      const check = await fetch(await storage.getPresignedGetUrl(key, 120), { headers: { Range: 'bytes=0-0' } });
      if (!check.ok) throw new Error(`Verifikasi unggahan gagal (${check.status}) untuk ${key}`);
    }

    const resolvedLessonId = lessonId ?? (await findLessonId(guid));
    const data = {
      audioKey: `${prefix}/`,
      version,
      codec: codec === 'aac' ? 'aac' : 'aac-128k',
      durationSec,
      bytes,
      sha256,
      segments,
      isActive: true,
      encodedAt: new Date(),
      lessonId: resolvedLessonId,
      sourceKey,
    };
    await prisma.mediaAudioSource.upsert({ where: { guid }, create: { guid, ...data }, update: data });
    // An upload has no Bunny `length` for normalize-slides-data to find, so this
    // job is the only thing that knows how long the audio is.
    if (sourceKey) await stampSlideDuration(guid, durationSec);
    return { version, parts: segments.length, durationSec, bytes, res };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Stream the MP4 to disk (a lesson is 60–150 MB; the cron task has 512 MB). */
async function downloadBunnyMp4(guid: string, dest: string): Promise<string> {
  const tried: string[] = [];
  for (const res of RESOLUTIONS) {
    // Token auth is on in `signed` mode; in `proxy` mode the Referer alone opens it.
    const url =
      env.media.mode === 'signed'
        ? signBunnyMp4Url(guid, res, { ttlSeconds: 900 })
        : `https://${env.bunny.streamCdnHost}/${guid}/play_${res}.mp4`;
    const resp = await fetch(url, { headers: { Referer: env.bunny.referer } });
    if (resp.ok && resp.body) {
      await pipeline(Readable.fromWeb(resp.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
      return res;
    }
    tried.push(`${res}=${resp.status}`);
  }
  throw new Error(`MP4 tidak ditemukan di Bunny untuk guid ini (${tried.join(', ')})`);
}

async function ffprobe(args: string[]): Promise<string> {
  const { stdout } = await run('ffprobe', ['-v', 'error', ...args], { maxBuffer: 1 << 20 });
  return stdout.trim();
}

function sha256Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', (c) => hash.update(c)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

/** The lesson whose slides reference this guid — same predicate as the ops view. */
async function findLessonId(guid: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT l.id FROM course_lessons l
    WHERE jsonb_typeof(l.slides_data) = 'array'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(l.slides_data) e
        WHERE e->'data'->>'guid' = ${guid}
           OR e->'data'->'audio'->>'guid' = ${guid}
           OR e->'data'->'video'->>'guid' = ${guid})
    ORDER BY l.created_at LIMIT 1`;
  return rows[0]?.id ?? null;
}

/**
 * Write the real duration into every audio slide that plays `guid`, in the lean
 * shape (`data.guid` + `data.durationSec`), and move `Lesson.duration` by the
 * difference. A delta, not a re-sum: sibling media slides the backoffice saved
 * raw-lite carry no `durationSec` until normalize runs, and summing them as 0
 * would shrink the lesson. No slide yet (uploaded, not saved) = no-op; the
 * backoffice save path stamps it from `media_audio_sources` instead.
 */
async function stampSlideDuration(guid: string, durationSec: number): Promise<void> {
  await prisma.$executeRaw`
    WITH hit AS (
      SELECT l.id,
             (SELECT COALESCE(sum(COALESCE((e->'data'->>'durationSec')::int, 0)), 0)
                FROM jsonb_array_elements(l.slides_data) e
               WHERE e->>'type' = 'AudioTemplate'
                 AND COALESCE(e->'data'->>'guid', e->'data'->'audio'->>'guid') = ${guid}) AS old_sec,
             (SELECT count(*) FROM jsonb_array_elements(l.slides_data) e
               WHERE e->>'type' = 'AudioTemplate'
                 AND COALESCE(e->'data'->>'guid', e->'data'->'audio'->>'guid') = ${guid}) AS n
      FROM course_lessons l
      WHERE jsonb_typeof(l.slides_data) = 'array'
    )
    UPDATE course_lessons l
    SET slides_data = (
          SELECT jsonb_agg(
                   CASE WHEN e->>'type' = 'AudioTemplate'
                         AND COALESCE(e->'data'->>'guid', e->'data'->'audio'->>'guid') = ${guid}
                        THEN jsonb_set(e, '{data}',
                               ((e->'data') - 'audio') || jsonb_build_object('guid', ${guid}::text, 'durationSec', ${durationSec}::int))
                        ELSE e END
                   ORDER BY ord)
          FROM jsonb_array_elements(l.slides_data) WITH ORDINALITY AS t(e, ord)),
        duration = GREATEST(0, COALESCE(l.duration, 0) + (${durationSec}::int * hit.n)::int - hit.old_sec::int)
    FROM hit
    WHERE hit.id = l.id AND hit.n > 0`;
}
