/**
 * Canonical "published" post status is `PUBLISHED` — that's what the app writes
 * on create. But the legacy DB stored `publish` (lowercase), and the
 * network-post migration uppercased it to `PUBLISH` (see
 * scripts/migrate-network-posts.ts). To avoid a data backfill, every READ-side
 * publish gate accepts both spellings. Writes stay `PUBLISHED`.
 */
export const PUBLISHED_STATUS = 'PUBLISHED';

/** All status values that count as publicly visible / published. */
export const PUBLISHED_STATUSES: string[] = [PUBLISHED_STATUS, 'PUBLISH'];

/** Prisma `where` fragment for the published gate: `{ in: [...] }`. */
export const PUBLISHED_STATUS_FILTER = { in: PUBLISHED_STATUSES } as const;

export function isPublished(status: string | null | undefined): boolean {
  return status != null && PUBLISHED_STATUSES.includes(status);
}
