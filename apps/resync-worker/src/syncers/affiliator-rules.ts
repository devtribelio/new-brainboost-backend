/**
 * Pure decision rules for the program-membership (member_product_affiliator) pass of the
 * tree syncer — no I/O, tested table-driven in tests/affiliator-rules.spec.ts.
 */
import { toDate } from '../util';

/** The legacy columns that decide whether a membership is live. */
export interface LegacyAffiliatorState {
  status: unknown;
  exitState: unknown;
  deleted: unknown;
  deleteAt: unknown;
}

/**
 * A legacy membership is live only while `status > 0` with no exit and no delete stamp.
 * A chief's kick (studio/affiliate/chief/people.php::deleteMemberProduct) writes
 * `exit_state='KICK'`, `exit_date`, `delete_at` and `status=0` — `deleted` is a DATETIME,
 * not a flag (a zero-date reads as unset).
 */
export function isLegacyAffiliatorActive(r: LegacyAffiliatorState): boolean {
  const exited = r.exitState !== null && r.exitState !== undefined && r.exitState !== '';
  return Number(r.status) > 0 && !exited && toDate(r.deleted) === null && toDate(r.deleteAt) === null;
}

/** The Postgres MemberAffiliator currently holding a (member, program) pair. */
export interface ExistingAffiliator {
  legacyId: number | null;
  isActive: boolean;
}

export type AffiliatorWrite = 'create' | 'refresh' | 'repoint' | 'skip';

/**
 * - no row for the pair          → create
 * - the pair is THIS legacy row  → refresh
 * - held by a new-system row     → skip (joined in the app — not ours)
 * - held by another legacy row   → repoint onto the incoming row when it is live and the
 *                                  held one is dead, or the incoming one is newer: a re-join
 *                                  after a kick writes a NEW legacy row (the soft-deleted one
 *                                  is invisible to TBAffiliator_Product::createProductAffiliator),
 *                                  so a live higher id means the older row was removed.
 *                                  Anything else is kept.
 */
export function decideAffiliatorWrite(
  existing: ExistingAffiliator | undefined,
  incoming: { legacyId: number; isActive: boolean },
): AffiliatorWrite {
  if (!existing) return 'create';
  if (existing.legacyId === incoming.legacyId) return 'refresh';
  if (existing.legacyId === null) return 'skip';
  if (incoming.isActive && (!existing.isActive || incoming.legacyId > existing.legacyId)) return 'repoint';
  return 'skip';
}

/**
 * Of several legacy rows for the same pair in one scan, the one to apply: a live row over
 * a dead one, then the newest. Applying only that row keeps the result independent of the
 * order the concurrent writer happens to run them in.
 */
export function prefersAffiliatorRow(
  a: { legacyId: number; isActive: boolean },
  b: { legacyId: number; isActive: boolean },
): boolean {
  if (a.isActive !== b.isActive) return a.isActive;
  return a.legacyId > b.legacyId;
}
