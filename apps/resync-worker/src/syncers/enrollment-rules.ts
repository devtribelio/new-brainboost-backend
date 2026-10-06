/**
 * Pure decision rules for the enrollments syncer — no I/O, so they can be tested
 * table-driven (tests/enrollment-rules.spec.ts). See docs/legacy-resync-plan.md §enrollments.
 */

/** Stamped on rows cancelled because legacy removed them, so support can tell them apart from a refund. */
export const LEGACY_CANCEL_REASON = 'legacy_removed';

/** The Postgres enrollment currently holding a (member, course) pair. */
export interface ExistingEnrollment {
  id: string;
  legacyId: number | null;
  isCanceled: boolean;
  cancelationReason: string | null;
  expiredDate: Date | null;
  progress: number;
}

export type EnrollmentWrite = 'create' | 'refresh' | 'uncancel' | 'repoint' | 'skip';

/**
 * What to do with an incoming ACTIVE legacy row (status = 1, has access).
 *
 * - no row for the pair            → create
 * - the pair is OUR row            → refresh; uncancel too when legacy had removed it and
 *                                     now reactivated it (a refund cancel is never undone)
 * - held by a new-system row       → skip (an app purchase or an employee grant — not ours)
 * - held by another legacy row     → repoint onto the new legacy row when the old one is dead
 *                                     (cancelled, or a trial past its expiry), or when it is a
 *                                     time-boxed trial and the incoming row is a paid (lifetime)
 *                                     one: legacy writes a NEW course_enrollment row on re-enrol,
 *                                     and skipping it left the buyer behind the old row — the paid
 *                                     row sinks below the watermark and the trial later expires.
 *                                     Any other live row is kept. A refund-cancelled row is
 *                                     re-pointed only by a PAID incoming row.
 */
export function decideEnrollmentWrite(
  existing: ExistingEnrollment | undefined,
  legacyId: number,
  now: Date,
  incomingExpiredDate: Date | null = null,
  incomingPaid = true,
): EnrollmentWrite {
  if (!existing) return 'create';
  if (existing.legacyId === legacyId) {
    return existing.isCanceled && existing.cancelationReason === LEGACY_CANCEL_REASON ? 'uncancel' : 'refresh';
  }
  if (existing.legacyId === null) return 'skip';
  const expired = existing.expiredDate !== null && existing.expiredDate.getTime() < now.getTime();
  const paidOverTrial = existing.expiredDate !== null && incomingExpiredDate === null;
  // A refund cancel (reason other than legacy_removed) is lifted only by a real re-purchase,
  // never by a free / admin-granted legacy row.
  const deadByLegacy = existing.isCanceled && (existing.cancelationReason === LEGACY_CANCEL_REASON || incomingPaid);
  return deadByLegacy || (!existing.isCanceled && (expired || paidOverTrial)) ? 'repoint' : 'skip';
}

export interface CancelRemovedInput {
  existing: ExistingEnrollment | undefined;
  /** legacy course_enrollment_id that legacy just removed (status = 0). */
  legacyId: number;
  /** other legacy rows for the same (member, course) — redirect-resolved — still status = 1 with access. */
  otherActiveLegacyRows: number;
  /** the member has a PAID commerce_transactions order for the course's product. */
  hasPaidOrder: boolean;
}

/**
 * A legacy removal may cancel the Postgres row only when that row is the one THIS legacy
 * row created, and nothing else still entitles the member to the course: no other active
 * legacy enrollment (a re-enrol writes a new row before the trial cron removes the old one)
 * and no paid order in the new system.
 */
export function mayCancelRemoved(input: CancelRemovedInput): boolean {
  const { existing, legacyId, otherActiveLegacyRows, hasPaidOrder } = input;
  if (!existing || existing.legacyId !== legacyId || existing.isCanceled) return false;
  return otherActiveLegacyRows === 0 && !hasPaidOrder;
}
