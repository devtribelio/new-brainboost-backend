import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { S3StorageService, s3StorageService } from '@bb/common/services/s3-storage.service';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';

/** Default age before an unreferenced upload is swept. */
export const ORPHAN_UPLOAD_TTL_HOURS = 168; // 7 days

/** Max objects deleted per run — bounds the work of a single tick. */
const BATCH = 500;

/**
 * ⚠️ ONLY these kinds are swept.
 *
 * The registry records EVERY upload (audit), but a row is only stamped
 * `referencedAt` by a consumer that was instrumented to claim it — today that
 * is post creation alone. Sweeping a kind whose consumer does not claim (avatar,
 * cover, comment, network) would delete files that ARE in use, because their
 * rows stay NULL forever. Add a kind here ONLY after its consumer calls
 * `markUploadsReferenced`.
 */
const SWEEPABLE_KINDS = ['post'];

/**
 * Background job: delete orphaned uploads (§4 / BB-116).
 *
 * The upload flow is two-step (upload → later referenced by a post), so a file
 * whose post was never created sits in the bucket forever — there is no
 * client-side delete, only a server sweep can remove it.
 *
 * A row qualifies when it is unreferenced AND older than the TTL. The object is
 * deleted from S3 FIRST, and only then is the row removed: if S3 fails, the row
 * survives and the next run retries, so we never lose track of a live object.
 *
 * TTL is deliberately generous (7 days, runtime-configurable via app_settings
 * `upload.orphanTtlHours`): deleting is irreversible, while keeping a stray webp
 * costs almost nothing — and a client that uploads early then finishes the post
 * later must not have its image deleted mid-compose.
 *
 * @param now      Reference timestamp (defaults to now). Injectable for tests.
 * @param ttlHours Override the TTL window.
 * @param storage  Injectable for tests.
 */
export async function sweepOrphanUploads(
  now: Date = new Date(),
  ttlHours?: number,
  storage: S3StorageService = s3StorageService,
): Promise<{ deleted: number; failed: number }> {
  const hours =
    ttlHours ??
    (await settingsService.getNumber(SETTING_KEYS.uploadOrphanTtlHours, ORPHAN_UPLOAD_TTL_HOURS));
  const cutoff = new Date(now.getTime() - hours * 3_600_000);

  const rows = await prisma.uploadedFile.findMany({
    where: {
      referencedAt: null,
      createdAt: { lt: cutoff },
      kind: { in: SWEEPABLE_KINDS },
    },
    select: { id: true, key: true },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  });

  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await storage.deleteObject(row.key);
      await prisma.uploadedFile.delete({ where: { id: row.id } });
      deleted += 1;
    } catch (err) {
      // Row is kept on purpose → retried next run.
      failed += 1;
      logger.error({ err, key: row.key }, '[sweep-orphan-uploads] failed to delete object');
    }
  }

  if (deleted > 0 || failed > 0) {
    logger.info({ deleted, failed, cutoff, ttlHours: hours }, '[sweep-orphan-uploads] done');
  }
  return { deleted, failed };
}
