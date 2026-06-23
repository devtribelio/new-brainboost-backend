import { addDays, dayKey } from './tracker.time';

/**
 * Strict consecutive-day streak (spec §6/§8).
 *
 * Given the set of WIB days that "qualify" (per-day listened ≥ MIN_QUALIFY_SEC),
 * count consecutive qualifying days walking backward from today (WIB). If today
 * has not qualified *yet*, start from yesterday — the streak is not considered
 * broken until the day actually rolls over. Any earlier gap resets to 0.
 *
 * Used for both the global streak and per-program challenge `day` (caller pre-
 * filters `qualifyingDays` to a single course for the per-program case).
 *
 * @param qualifyingDays UTC-midnight WIB day Dates that met the threshold.
 * @param todayWIB       today's WIB day as a UTC-midnight Date (`toLocalDayWIB(now)`).
 */
export function computeStreak(qualifyingDays: Date[], todayWIB: Date): number {
  const set = new Set(qualifyingDays.map(dayKey));

  // Anchor: today if it already qualifies, else yesterday (grace until rollover).
  let cursor = set.has(dayKey(todayWIB)) ? todayWIB : addDays(todayWIB, -1);

  let streak = 0;
  while (set.has(dayKey(cursor))) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}
