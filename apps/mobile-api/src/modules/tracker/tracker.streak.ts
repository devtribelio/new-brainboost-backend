import { addDays, dayKey } from './tracker.time';

/**
 * Where a member's streak stands right now (spec `docs/tracker-streak.md` §5.2).
 *
 * - `burning`  — this listening day already qualifies.
 * - `at_risk`  — not yet today, but yesterday qualified. The number still stands.
 * - `dimmed`   — yesterday did NOT qualify and grace is carrying the streak; the
 *                member can revive it by listening 10 minutes before the day closes.
 * - `none`     — no streak.
 */
export type StreakState = 'burning' | 'at_risk' | 'dimmed' | 'none';

export interface StreakResult {
  days: number;
  state: StreakState;
  /**
   * Missed days grace forgave. Shown ❄️ in the weekly calendar; never counted in `days`.
   *
   * Only days that BRIDGE the streak appear here — there is always a qualifying day
   * further back that the walk went on to count. A gap the walk broke on forgave
   * nothing and is reported as a plain miss instead.
   */
  forgivenDays: Date[];
}

/**
 * Consecutive-day streak over listening days (04:00 WIB boundary), with an optional
 * grace window.
 *
 * Walk backward from today. If today has not qualified *yet*, start from yesterday —
 * the streak is not broken until the day actually rolls over.
 *
 * A non-qualifying day is forgiven only while it sits within `graceDays` listening
 * days of TODAY; anything older ends the walk. Anchoring the window on today rather
 * than on the gap is the whole safety property: the streak is recomputed from raw
 * sessions on every read, so a gap-relative rule would forgive every single-day gap
 * in the member's entire history the moment grace is switched on. `graceDays = 0`
 * forgives nothing and reproduces the original strict walk exactly.
 *
 * Used for the global streak and for the per-program challenge `day` (the caller
 * pre-filters `qualifyingDays` to one course for the latter).
 *
 * @param qualifyingDays UTC-midnight listening-day Dates that met the threshold.
 * @param todayWIB       today's listening day (`toListeningDayWIB(now)`).
 * @param graceDays      size of the grace window in listening days; 0 = strict.
 */
export function computeStreakState(
  qualifyingDays: Date[],
  todayWIB: Date,
  graceDays = 0,
): StreakResult {
  const set = new Set(qualifyingDays.map(dayKey));
  const qualifiedToday = set.has(dayKey(todayWIB));
  const forgivenDays: Date[] = [];
  const pendingForgiven: Date[] = [];

  let cursor = qualifiedToday ? todayWIB : addDays(todayWIB, -1);
  let days = 0;

  for (;;) {
    if (set.has(dayKey(cursor))) {
      days += 1;
      // The walk got past the gap, so those days really did bridge two qualifying
      // days. Only now are they forgiven.
      forgivenDays.push(...pendingForgiven);
      pendingForgiven.length = 0;
    } else if ((todayWIB.getTime() - cursor.getTime()) / 86_400_000 <= graceDays) {
      pendingForgiven.push(cursor);
    } else {
      break;
    }
    cursor = addDays(cursor, -1);
  }
  // Anything still pending is dropped on purpose: the walk broke right after it, so
  // it joined a qualifying day to nothing. A member who has never listened, or whose
  // streak died days ago, must not be shown a frozen day forgiving a streak that was
  // not there — `days === 0 ⇒ forgivenDays === []` falls out of this, no special case.

  let state: StreakState;
  if (days === 0) state = 'none';
  else if (qualifiedToday) state = 'burning';
  else if (set.has(dayKey(addDays(todayWIB, -1)))) state = 'at_risk';
  else state = 'dimmed';

  return { days, state, forgivenDays };
}

/** Streak length only — the shape callers that don't care about state still use. */
export function computeStreak(qualifyingDays: Date[], todayWIB: Date, graceDays = 0): number {
  return computeStreakState(qualifyingDays, todayWIB, graceDays).days;
}
