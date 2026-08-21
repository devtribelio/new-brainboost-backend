/**
 * Upgrade proration — credit the unused part of the running term, charge the
 * full price of the new plan, and start a fresh term from the payment date.
 * This mirrors what Apple does on iOS, so support has ONE explanation for every
 * platform rather than one per store.
 *
 *   credit = oldPrice × remainingDays / termDays
 *   charge = newPrice − credit        (clamped at zero)
 *
 * Deliberate choices:
 * - **Calendar days, not seconds.** Nobody audits the hours, and a number the
 *   member can recompute on a calendar is a number support can defend.
 * - **Round once, at the end.** Rounding each step drifts by a rupiah or two and
 *   makes the arithmetic irreproducible.
 * - **A member already in grace has zero remaining days**, so the credit is zero
 *   and the charge is the full price — the formula collapses into a plain
 *   renewal on its own, with no special case to keep in sync.
 * - **Clamped at zero** rather than trusted: tier ordering is enforced upstream,
 *   but a negative charge would be a refund we never intended to issue.
 *
 * On iOS none of this runs — Apple bills the difference itself and we never see
 * the numbers, only the resulting entitlement.
 */
export interface ProrationInput {
  /** Price of the plan being left, in IDR. */
  oldPrice: number;
  /** Price of the plan being bought, in IDR. */
  newPrice: number;
  /** Current expiry of the running term. */
  expiresAt: Date;
  /** Length of the running term, used to derive its start date. */
  periodMonths: number;
  now: Date;
}

export interface ProrationResult {
  credit: number;
  charge: number;
  remainingDays: number;
  termDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function computeProration(input: ProrationInput): ProrationResult {
  const termStart = new Date(input.expiresAt);
  termStart.setMonth(termStart.getMonth() - input.periodMonths);

  const termDays = diffDays(termStart, input.expiresAt);
  const remainingDays = clamp(diffDays(input.now, input.expiresAt), 0, termDays);

  const credit = termDays > 0 ? Math.floor((input.oldPrice * remainingDays) / termDays) : 0;
  const charge = Math.max(0, input.newPrice - credit);
  return { credit, charge, remainingDays, termDays };
}

/** Whole calendar days between two instants, floored at zero. */
function diffDays(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
