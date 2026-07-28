import { prisma } from '@bb/db';
import { logger } from '../config/logger';

/**
 * Registry of objects written to S3 by the upload endpoint (§4 / BB-116).
 *
 * The upload flow is two-step — the client uploads first and only later sends
 * the URL back when creating the post — so a file whose post is never created
 * is invisible: it exists in the bucket with nothing pointing at it, and there
 * is no client-side delete. This registry makes those orphans findable:
 *   upload  → row with referencedAt = NULL
 *   consume → referencedAt stamped (see `markUploadsReferenced`)
 *   sweep   → rows still NULL past the TTL get their object deleted
 *
 * Every function here is BEST-EFFORT: bookkeeping must never fail the user's
 * actual action (an upload or a published post). Failures are logged, swallowed,
 * and self-heal — a missing row only means that object is never swept.
 */

export interface RecordUploadInput {
  key: string;
  publicUrl: string;
  ownerId: string;
  kind: string;
  fileName?: string | null;
  mimeType: string;
  sizeBytes: number;
}

/** Register a freshly uploaded object. Idempotent on `key` (unique). */
export async function recordUpload(input: RecordUploadInput): Promise<void> {
  try {
    await prisma.uploadedFile.upsert({
      where: { key: input.key },
      create: {
        key: input.key,
        publicUrl: input.publicUrl,
        ownerId: input.ownerId,
        kind: input.kind,
        fileName: input.fileName ?? null,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
      },
      update: {}, // same key re-uploaded → keep the original row
    });
  } catch (err) {
    logger.error({ err, key: input.key }, '[upload-registry] failed to record upload');
  }
}

/**
 * Claim uploads referenced by a newly created entity so the sweep skips them.
 *
 * `values` are whatever the client sent back: the upload endpoint returns BOTH
 * the object key (`url`) and the CDN URL (`fullUrl`), and either may come back,
 * so both columns are matched. Only unreferenced rows are stamped — a file
 * already claimed by an earlier post keeps its first owner.
 */
export async function markUploadsReferenced(
  values: string[],
  referenceType: string,
  referenceId: string,
): Promise<void> {
  if (!values || values.length === 0) return;
  try {
    await prisma.uploadedFile.updateMany({
      where: {
        referencedAt: null,
        OR: [{ key: { in: values } }, { publicUrl: { in: values } }],
      },
      data: { referencedAt: new Date(), referenceType, referenceId },
    });
  } catch (err) {
    logger.error({ err, referenceType, referenceId }, '[upload-registry] failed to mark referenced');
  }
}
