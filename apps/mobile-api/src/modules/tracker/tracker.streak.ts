import { addDays, dayKey } from './tracker.time';

/**
 * Where a member's streak stands right now (spec `docs/tracker-streak.md` §5.2).
 *
 * - `burning`  — this listening day already qualifies.
 * - `at_risk`  — not yet today, but yesterday qualified. The number still stands.
 * - `dimmed`   — yesterday did NOT qualify and a freeze is carrying the streak; the
 *                member can revive it by listening 10 minutes before the day closes.
 * - `none`     — no streak.
 */
export type StreakState = 'burning' | 'at_risk' | 'dimmed' | 'none';

/** What a single past day looks like on a calendar. `at_risk`/`future` are today-relative
 *  and decided by the caller, never by the walk. */
export type StreakDayState = 'burning' | 'dimmed' | 'none';

export interface StreakOptions {
  /** Consecutive missed days a single gap may span and still be bridgeable. 0 = strict. */
  graceDays?: number;
  /** Qualifying days that earn one freeze. <= 0 disables freezes entirely (fail-safe). */
  freezeEarnEvery?: number;
}

export interface StreakResult {
  days: number;
  state: StreakState;
  /**
   * Missed days a freeze forgave inside the CURRENT streak. Shown ❄️ in the weekly
   * calendar; never counted in `days`.
   */
  forgivenDays: Date[];
  /**
   * Every day from the member's first qualifying day to today, with the verdict the
   * walk itself reached. This is the ONLY source a calendar or weekly strip may use:
   * a second predicate answering the same date is how a frozen cell ends up
   * contradicting the streak number printed above it.
   */
  dayStates: Map<string, StreakDayState>;
}

/**
 * The streak, and the state of every day behind it, from ONE forward pass.
 *
 * ## Why a freeze is earned, not granted by recency
 *
 * The rule this replaces forgave a missed day only while it sat within `graceDays`
 * of TODAY. That anchor was doing two jobs at once, and only one of them was its own.
 *
 * Its real job was to stop a read-time streak from forgiving every single-day gap in
 * a member's history at once — without some limit, a member who listens every OTHER
 * day has every gap forgiven and their streak becomes "days listened, ever". That
 * hazard is real and this function still has to answer it.
 *
 * Its accidental job was deciding whether a freeze bridges the streak at all — and
 * there it was actively wrong, because a freeze then silently expired. Measured on a
 * real member: listened the 15th, missed the 16th, listened the 17th → streak 2 with
 * the 16th frozen. Listened AGAIN on the 18th → streak still 2, because by then the
 * 16th was two days back and the walk refused to cross it. The 15th fell off. They
 * listened two days running after using a freeze and gained nothing; the streak
 * shrank because time passed, not because they missed a day.
 *
 * So the limit moves to where it belongs: a freeze is **earned** by listening.
 * `freezeEarnEvery` qualifying days inside the current streak earn one freeze, and a
 * gap is bridged only if the streak had earned enough by then. The every-other-day
 * member earns nothing (their run never reaches the bar before the next gap) and
 * still lands on a streak of 1; a member 45 days in has earned theirs and keeps it.
 * Nothing is stored — the quota is a function of the same rows the streak is, so it
 * cannot drift from them.
 *
 * The RATE is the whole limit; there is deliberately no ceiling on top of it. A cap
 * would only ever bind on a long streak, where it says a member two years in may take
 * their third sick day and lose everything — while the rate already forces roughly
 * six qualifying days per forgiven one, which is the behaviour the limit exists to
 * require.
 *
 * ## Why forward, and why one pass
 *
 * A freeze's affordability depends on how long the run was *at that moment*, which is
 * a fact about the past; walking backward from today cannot know it without
 * re-walking. Going forward, `run` IS that fact.
 *
 * The pass also emits `dayStates` for the whole history, so the calendar reads the
 * walk's own verdict instead of re-deriving one. That is not tidiness: two predicates
 * answering the same date is exactly how the calendar came to paint a day frozen
 * while the number above it said the streak had broken there.
 *
 * `graceDays = 0` forgives nothing and reproduces the original strict walk exactly,
 * which is what lets this deploy independently of the product decision.
 *
 * @param qualifyingDays UTC-midnight listening-day Dates that met the threshold.
 * @param todayWIB       today's listening day (`toListeningDayWIB(now)`).
 */
export function walkStreak(
  qualifyingDays: Date[],
  todayWIB: Date,
  opts: StreakOptions = {},
): StreakResult {
  const graceDays = opts.graceDays ?? 0;
  const earnEvery = opts.freezeEarnEvery ?? 0;

  const qualifying = new Set(qualifyingDays.map(dayKey));
  const dayStates = new Map<string, StreakDayState>();
  if (qualifying.size === 0) {
    return { days: 0, state: 'none', forgivenDays: [], dayStates };
  }

  /** Has this run earned the freezes it is about to spend? */
  const affordable = (run: number, spent: number, want: number): boolean => {
    if (graceDays <= 0 || earnEvery <= 0) return false;
    return spent + want <= Math.floor(run / earnEvery);
  };

  const sorted = [...qualifyingDays].sort((a, b) => a.getTime() - b.getTime());
  const start = sorted[0];

  let run = 0;
  let spent = 0;
  let frozen: Date[] = [];
  /** Missed days since the last qualifying one. Undecided until a qualifying day
   *  arrives (they bridge) or the gap outgrows what the streak can pay for. */
  let pending: Date[] = [];

  const breakStreak = () => {
    for (const p of pending) dayStates.set(dayKey(p), 'none');
    pending = [];
    run = 0;
    spent = 0;
    frozen = [];
  };

  for (let d = start; d.getTime() <= todayWIB.getTime(); d = addDays(d, 1)) {
    if (qualifying.has(dayKey(d))) {
      if (pending.length > 0) {
        // The gap ended here, so now we know whether it was bridgeable.
        for (const p of pending) dayStates.set(dayKey(p), 'dimmed');
        spent += pending.length;
        frozen.push(...pending);
        pending = [];
      }
      dayStates.set(dayKey(d), 'burning');
      run += 1;
      continue;
    }

    // TODAY is not a miss — it has not finished yet. The streak is not broken until
    // the day actually rolls over, which is what `at_risk` means: a member at 20:00
    // who has not listened tonight still has their number. Counting it as a miss
    // resets every streak in the app for most of every day.
    if (d.getTime() === todayWIB.getTime()) break;

    pending.push(d);
    // Decide as soon as the gap becomes unpayable, so a trailing run of misses
    // resets the streak without waiting for a qualifying day that never comes.
    if (pending.length > graceDays || !affordable(run, spent, pending.length)) breakStreak();
  }

  // Days still pending at the tail are inside a gap the streak can currently afford:
  // undecided, revivable, and rendered as frozen until the member misses one too many.
  for (const p of pending) dayStates.set(dayKey(p), 'dimmed');

  let state: StreakState;
  if (run === 0) state = 'none';
  else if (qualifying.has(dayKey(todayWIB))) state = 'burning';
  else if (qualifying.has(dayKey(addDays(todayWIB, -1)))) state = 'at_risk';
  else state = 'dimmed';

  return { days: run, state, forgivenDays: [...frozen, ...pending], dayStates };
}

/** Streak length + state. Thin wrapper kept for callers that do not need `dayStates`. */
export function computeStreakState(
  qualifyingDays: Date[],
  todayWIB: Date,
  opts: StreakOptions = {},
): StreakResult {
  return walkStreak(qualifyingDays, todayWIB, opts);
}

/** Streak length only — the shape callers that don't care about state still use. */
export function computeStreak(
  qualifyingDays: Date[],
  todayWIB: Date,
  opts: StreakOptions = {},
): number {
  return walkStreak(qualifyingDays, todayWIB, opts).days;
}
