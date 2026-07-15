/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Members syncer — incremental, NEW-WINS-ON-TOUCH (docs/specs/legacy-resync-plan.md §6).
 *
 * Only migrated winners (Member.legacyId set) are touched. Identity (email/phone/verified),
 * password, kyc*, bank*, affiliate* are NOT owned here — only profile fields + deactivation:
 *   fullName, avatarUrl, bio, isActive(=is_active && !is_deleted).
 *
 * Gate: if the app changed the row since the last resync (updatedAt > legacySyncedAt) the
 * profile is left alone (new wins) — but a legacy deactivation (is_deleted) always
 * propagates. Untouched rows are overwritten via a raw UPDATE that sets updated_at and
 * legacy_synced_at to the same now() so the next run still sees "untouched".
 *
 * New legacy members that just entered brainboost scope are NOT discovered here — they are
 * created on demand by ctx.ensureMember in the enrollments/commissions/tree/posts/reviews
 * syncers. So this syncer only needs to watch the ALREADY-migrated members for changes:
 * it scans `member_id IN (our migrated legacyIds)` (PK-indexed, chunked) instead of the
 * whole ~700k legacy member table — the bulk of which it used to fetch then discard.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { resyncConfig } from '../config';
import { emptyStats, type Stats, type Syncer, type SyncerCtx } from '../types';
import { bool, maxWatermark, nonEmpty, runConcurrent, sinceBound, toDate } from '../util';

const CHUNK = 5000; // legacy member_id IN (...) batch

function fullNameOf(r: any): string | null {
  return (
    nonEmpty(r.name) ??
    ([nonEmpty(r.first_name), nonEmpty(r.last_name)].filter(Boolean).join(' ') || null)
  );
}

export const membersSyncer: Syncer = {
  name: 'members',
  async run(ctx: SyncerCtx): Promise<Stats> {
    const stats = emptyStats();
    const since = sinceBound(ctx.since);

    // only the already-migrated members (winner legacyIds) are subjects
    const legacyIds = [...ctx.memberByLegacy.keys()];
    let watermark = ctx.since;

    for (let i = 0; i < legacyIds.length; i += CHUNK) {
      const idChunk = legacyIds.slice(i, i + CHUNK);
      const [rows] = await ctx.legacy.query<RowDataPacket[]>(
        `SELECT member_id, name, first_name, last_name, image_url, biography,
                is_active, is_deleted, COALESCE(\`updated\`, \`created\`) AS wm
           FROM member
          WHERE member_id IN (?) AND COALESCE(\`updated\`, \`created\`) > ?`,
        [idChunk, since],
      );
      if ((rows as any[]).length === 0) continue;

      // current Postgres state for the touch-gate
      const ids = (rows as any[]).map((r) => ctx.memberByLegacy.get(Number(r.member_id))!);
      const current = new Map<string, { updatedAt: Date; legacySyncedAt: Date | null }>();
      for (const m of await ctx.prisma.member.findMany({
        where: { id: { in: ids } },
        select: { id: true, updatedAt: true, legacySyncedAt: true },
      })) {
        current.set(m.id, { updatedAt: m.updatedAt, legacySyncedAt: m.legacySyncedAt });
      }

      // one member_id per row (PK IN) → rows are write-independent → safe to parallelise
      await runConcurrent(rows as any[], resyncConfig.writeConcurrency, async (r) => {
        stats.scanned += 1;
        watermark = maxWatermark(watermark, toDate(r.wm));
        const id = ctx.memberByLegacy.get(Number(r.member_id))!; // guaranteed: member_id ∈ our set
        const cur = current.get(id);
        const isActive = bool(r.is_active) && !bool(r.is_deleted);
        const touched = cur?.legacySyncedAt != null && cur.updatedAt.getTime() > cur.legacySyncedAt.getTime();

        if (ctx.dryRun) {
          stats.upserted += 1;
          return;
        }
        try {
          if (!touched) {
            // untouched → overwrite legacy-owned fields; both markers get the SAME app-side
            // timestamp ($6). NOT server now(): the columns are tz-less `timestamp` that
            // Prisma fills with app-clock UTC — a non-UTC server TimeZone (or app↔DB clock
            // skew) would corrupt the updatedAt/legacySyncedAt touch-gate comparison.
            await ctx.prisma.$executeRawUnsafe(
              `UPDATE "members"
                  SET "full_name" = $1, "avatar_url" = $2, "bio" = $3, "is_active" = $4,
                      "updated_at" = $6, "legacy_synced_at" = $6
                WHERE "id" = $5::uuid`,
              fullNameOf(r),
              nonEmpty(r.image_url),
              nonEmpty(r.biography),
              isActive,
              id,
              new Date(),
            );
            stats.upserted += 1;
          } else if (!isActive) {
            // app-touched but legacy says deactivated → propagate deactivation only
            await ctx.prisma.member.update({ where: { id }, data: { isActive: false } });
            stats.upserted += 1;
          } else {
            stats.skipped += 1; // app owns this profile now, nothing to propagate
          }
        } catch {
          stats.errors += 1;
        }
      });
    }

    // checkpoint once after all chunks — interruption re-runs the (bounded) syncer idempotently
    // rather than risk skipping an unprocessed chunk whose rows predate a per-chunk watermark.
    if (watermark && !ctx.dryRun) await ctx.checkpoint(watermark);
    return stats;
  },
};
