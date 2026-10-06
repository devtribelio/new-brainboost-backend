/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Members syncer — incremental, NEW-WINS-ON-TOUCH (docs/legacy-resync-plan.md §6).
 *
 * Only migrated winners (Member.legacyId set) are touched. Identity (email/phone/verified),
 * kyc*, bank*, affiliate* are NOT owned here — only profile fields + deactivation + password:
 *   fullName, avatarUrl, bio, isActive(=is_active && !is_deleted), passwordHash/passwordAlgo.
 *
 * Password: legacy still accepts registrations + resets during cutover, so the hash is
 * propagated. The algo is DERIVED from the hash shape (detectPasswordAlgo), never assumed:
 * legacy is md5 almost everywhere but ~440 rows hold a PHP password_hash() bcrypt digest,
 * and stamping those 'legacy' (= md5 alias in AuthService.verifyPassword) locks the member
 * out permanently. A NULL/empty legacy password never overwrites — it would clobber a real
 * hash with the social sentinel.
 *
 * Gate (planMemberSync, member-rules.ts) is PER FIELD, keyed on the app-edit markers that
 * only member-initiated app edits set — NOT on updatedAt (every Prisma write bumps it, so
 * the old `updatedAt > legacySyncedAt` gate read ~all members as touched):
 *   - profile  → only while profile_updated_at IS NULL
 *   - password → only while password_updated_at IS NULL (the lazy md5→bcrypt rehash on
 *                login deliberately does not set it, so a later legacy reset still flows)
 *   - is_active → follows legacy both ways, except no reactivation over an app-scheduled
 *                deletion.
 * legacy_synced_at is still stamped (provenance only — the gate no longer reads it).
 *
 * New legacy members that just entered brainboost scope are NOT discovered here — they are
 * created on demand by ctx.ensureMember in the enrollments/commissions/tree/posts/reviews
 * syncers. So this syncer only needs to watch the ALREADY-migrated members for changes:
 * it scans `member_id IN (our migrated legacyIds)` (PK-indexed, chunked) instead of the
 * whole ~700k legacy member table — the bulk of which it used to fetch then discard.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { resyncConfig } from '../config';
import { planMemberSync, type MemberSyncCurrent } from './member-rules';
import { emptyStats, type Stats, type Syncer, type SyncerCtx } from '../types';
import { bool, errCode, nonEmpty, runConcurrent, sinceBound, toDate, WatermarkTracker } from '../util';

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
    const wm = new WatermarkTracker();

    for (let i = 0; i < legacyIds.length; i += CHUNK) {
      const idChunk = legacyIds.slice(i, i + CHUNK);
      const [rows] = await ctx.legacy.query<RowDataPacket[]>(
        `SELECT member_id, name, first_name, last_name, image_url, biography,
                password, is_active, is_deleted, COALESCE(\`updated\`, \`created\`) AS wm
           FROM member
          WHERE member_id IN (?) AND COALESCE(\`updated\`, \`created\`) > ?`,
        [idChunk, since],
      );
      if ((rows as any[]).length === 0) continue;

      // current Postgres state for the per-field gate
      const ids = (rows as any[]).map((r) => ctx.memberByLegacy.get(Number(r.member_id))!);
      const current = new Map<string, MemberSyncCurrent>();
      for (const m of await ctx.prisma.member.findMany({
        where: { id: { in: ids } },
        select: { id: true, profileUpdatedAt: true, passwordUpdatedAt: true, scheduledDeletionAt: true },
      })) {
        current.set(m.id, m);
      }

      // one member_id per row (PK IN) → rows are write-independent → safe to parallelise
      await runConcurrent(rows as any[], resyncConfig.writeConcurrency, async (r) => {
        stats.scanned += 1;
        wm.seen(toDate(r.wm));
        const id = ctx.memberByLegacy.get(Number(r.member_id))!; // guaranteed: member_id ∈ our set
        const cur = current.get(id);
        if (!cur) {
          stats.skipped += 1; // row vanished since buildCtx
          return;
        }
        const plan = planMemberSync(cur, {
          fullName: fullNameOf(r),
          avatarUrl: nonEmpty(r.image_url),
          bio: nonEmpty(r.biography),
          password: nonEmpty(r.password),
          isActive: bool(r.is_active) && !bool(r.is_deleted),
        });

        if (ctx.dryRun) {
          stats.upserted += 1;
          return;
        }

        // $1 = app-side timestamp for BOTH updated_at and legacy_synced_at. NOT server
        // now(): the columns are tz-less `timestamp` that Prisma fills with app-clock UTC —
        // a non-UTC server TimeZone (or app↔DB clock skew) would skew them.
        const params: unknown[] = [new Date(), id];
        const set = ['"updated_at" = $1', '"legacy_synced_at" = $1'];
        const bind = (col: string, v: unknown) => {
          params.push(v);
          set.push(`"${col}" = $${params.length}`);
        };
        if (plan.profile) {
          bind('full_name', plan.profile.fullName);
          bind('avatar_url', plan.profile.avatarUrl);
          bind('bio', plan.profile.bio);
        }
        if (plan.password) {
          bind('password_hash', plan.password.hash);
          bind('password_algo', plan.password.algo);
        }
        if (plan.isActive !== null) bind('is_active', plan.isActive);

        try {
          await ctx.prisma.$executeRawUnsafe(
            `UPDATE "members" SET ${set.join(', ')} WHERE "id" = $2::uuid`,
            ...params,
          );
          stats.upserted += 1;
        } catch (err) {
          stats.errors += 1;
          wm.failed(toDate(r.wm));
          ctx.log(`ERROR write member_id=${r.member_id}: ${errCode(err)}`);
        }
      });
    }

    // checkpoint once after all chunks — interruption re-runs the (bounded) syncer idempotently
    // rather than risk skipping an unprocessed chunk whose rows predate a per-chunk watermark.
    await ctx.checkpoint(wm.result(ctx.runStart));
    return stats;
  },
};
