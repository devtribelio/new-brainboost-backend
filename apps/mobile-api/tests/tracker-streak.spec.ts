import { describe, it, expect } from 'vitest';
import { computeStreak, computeStreakState, walkStreak } from '@/modules/tracker/tracker.streak';
import { toLocalDayWIB } from '@/modules/tracker/tracker.time';

/** Build a WIB-midnight day Date from a YYYY-MM-DD string. */
const day = (iso: string) => toLocalDayWIB(new Date(`${iso}T05:00:00Z`)); // noon WIB → that day
const today = day('2026-06-23');

describe('computeStreak', () => {
  it('counts consecutive days ending today', () => {
    const days = ['2026-06-21', '2026-06-22', '2026-06-23'].map(day);
    expect(computeStreak(days, today)).toBe(3);
  });

  it('resets on a gap (only the unbroken tail counts)', () => {
    // gap on the 22nd → today + nothing-before-gap.
    const days = ['2026-06-19', '2026-06-20', '2026-06-23'].map(day);
    expect(computeStreak(days, today)).toBe(1);
  });

  it('does not break when today has not qualified yet but yesterday did', () => {
    const days = ['2026-06-21', '2026-06-22'].map(day); // today (23rd) absent
    expect(computeStreak(days, today)).toBe(2);
  });

  it('is zero when neither today nor yesterday qualified', () => {
    const days = ['2026-06-20', '2026-06-21'].map(day);
    expect(computeStreak(days, today)).toBe(0);
  });

  it('returns zero for no qualifying days', () => {
    expect(computeStreak([], today)).toBe(0);
  });

  it('handles the WIB midnight boundary correctly', () => {
    // A session at 17:30Z on the 22nd is 00:30 WIB on the 23rd → counts as the 23rd.
    const lateNight = toLocalDayWIB(new Date('2026-06-22T17:30:00Z'));
    const earlyEve = toLocalDayWIB(new Date('2026-06-21T15:00:00Z')); // 22:00 WIB on the 21st → 21st
    expect(computeStreak([earlyEve, day('2026-06-22'), lateNight], today)).toBe(3);
  });
});

/**
 * Grace mechanics, with the quota deliberately out of the way (`freezeEarnEvery: 1`)
 * so these assert the bridging rule itself rather than affordability. The quota has
 * its own block below.
 */
describe('computeStreakState with grace', () => {
  const GRACE = { graceDays: 1, freezeEarnEvery: 1 };
  const keys = (r: { forgivenDays: Date[] }) =>
    r.forgivenDays.map((d) => d.toISOString().slice(0, 10)).sort();

  it('carries the streak over a single missed day and keeps counting on revival', () => {
    const days = ['2026-06-20', '2026-06-21', '2026-06-23'].map(day); // gap on the 22nd
    const r = computeStreakState(days, today, GRACE);
    expect(r.days).toBe(3); // 23rd + 21st + 20th — the forgiven day is NOT counted
    expect(r.state).toBe('burning');
    expect(keys(r)).toEqual(['2026-06-22']);
  });

  it('reports dimmed while the missed day is still revivable', () => {
    const days = ['2026-06-20', '2026-06-21'].map(day); // missed yesterday, nothing today
    const r = computeStreakState(days, today, GRACE);
    expect(r.days).toBe(2);
    expect(r.state).toBe('dimmed');
  });

  it('resets after more consecutive missed days than the gap width allows', () => {
    const days = ['2026-06-19', '2026-06-20'].map(day); // 21st, 22nd, 23rd all missing
    const r = computeStreakState(days, today, GRACE);
    expect(r.days).toBe(0);
    expect(r.state).toBe('none');
    // Nothing was carried, so nothing was forgiven — the 22nd is a plain miss.
    expect(r.forgivenDays).toEqual([]);
  });

  it('is byte-identical to the strict walk when grace is off', () => {
    const days = ['2026-06-20', '2026-06-21'].map(day);
    const strict = computeStreakState(days, today, { graceDays: 0 });
    expect(strict.days).toBe(computeStreak(days, today));
    expect(strict.state).toBe('none');
    expect(strict.forgivenDays).toEqual([]);
  });

  it('marks at_risk when yesterday qualified but today has not yet', () => {
    const r = computeStreakState(['2026-06-21', '2026-06-22'].map(day), today, GRACE);
    expect(r.days).toBe(2);
    expect(r.state).toBe('at_risk');
  });
});

/**
 * The bug that forced the rule change: grace used to be measured from TODAY, so a
 * spent freeze silently expired and the streak it was holding collapsed a day later.
 *
 * Measured on a real member — listened the 15th, missed the 16th, listened the 17th
 * (streak 2, the 16th frozen), listened AGAIN on the 18th and the streak was STILL 2.
 * They listened two days running after using a freeze and gained nothing; the streak
 * shrank because time passed, not because they missed a day.
 */
describe('a spent freeze does not expire', () => {
  const GRACE = { graceDays: 1, freezeEarnEvery: 1 };
  // 20th ≙ the 15th · 21st missed ≙ the 16th · 22nd ≙ the 17th · 23rd (today) ≙ the 18th
  const days = ['2026-06-20', '2026-06-22', '2026-06-23'].map(day);

  it('keeps growing the streak the day after the freeze was spent', () => {
    const onRevival = computeStreakState(days, day('2026-06-22'), GRACE);
    expect(onRevival.days).toBe(2);

    const nextDay = computeStreakState(days, today, GRACE);
    expect(nextDay.days).toBe(3); // the number the member earned, not 2
    expect(nextDay.state).toBe('burning');
    expect(nextDay.forgivenDays.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-06-21']);
  });

  it('forgives a gap the member came back from however long ago, once earned', () => {
    // A bridged gap ten days back, with a run either side. Under the old today-anchored
    // rule this was a plain miss and everything before it was discarded.
    const long = [
      '2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13',
      '2026-06-14', '2026-06-15', '2026-06-16', '2026-06-17',
      // 18th missed
      '2026-06-19', '2026-06-20', '2026-06-21', '2026-06-22', '2026-06-23',
    ].map(day);
    const r = computeStreakState(long, today, { graceDays: 1, freezeEarnEvery: 7 });
    expect(r.days).toBe(15);
    expect(r.forgivenDays.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-06-18']);
  });
});

/**
 * A freeze is EARNED, and that quota is what makes the rule safe. Nothing is stored,
 * so without it every gap in a member's history is forgiven for free — and the
 * every-other-day listener below is not a hypothetical, it is what "I listen most
 * nights" looks like in the data.
 */
describe('freeze quota', () => {
  const EARN_7 = { graceDays: 1, freezeEarnEvery: 7 };

  it('collapses the every-other-day listener instead of handing them an endless streak', () => {
    // Listened the 13th, 15th, 17th, 19th, 21st, 23rd — every gap is one day wide, so
    // an unlimited rule bridges all of them and calls it a streak of 6.
    const alternate = ['2026-06-13', '2026-06-15', '2026-06-17', '2026-06-19', '2026-06-21', '2026-06-23']
      .map(day);
    const r = computeStreakState(alternate, today, EARN_7);
    expect(r.days).toBe(1); // they never reach the bar between gaps
    expect(r.forgivenDays).toEqual([]);
  });

  it('breaks the streak on a gap that arrives before the bar is reached', () => {
    // Three qualifying days then a gap: floor(3/7) = 0 freezes earned.
    const r = computeStreakState(['2026-06-19', '2026-06-20', '2026-06-21', '2026-06-23'].map(day), today, EARN_7);
    expect(r.days).toBe(1); // only today survives
    expect(r.forgivenDays).toEqual([]);
  });

  it('makes a second gap wait until it has been earned all over again', () => {
    // A gap on the 8th, bridged off the first seven days. The member then needs
    // another seven qualifying days before a second gap is affordable — the rate IS
    // the limit, so there is no separate ceiling to trip over.
    const tooSoon = [
      '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06', '2026-06-07',
      // 8th missed — bridged
      '2026-06-09', '2026-06-10', '2026-06-11',
      // 12th missed — only 3 qualifying days since, floor(10/7) = 1 and one is spent
      '2026-06-23',
    ].map(day);
    expect(computeStreakState(tooSoon, today, EARN_7).days).toBe(1);

    const earnedTwice = [
      '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06', '2026-06-07',
      // 8th missed — bridged
      '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14', '2026-06-15',
      '2026-06-16', '2026-06-17', '2026-06-18', '2026-06-19', '2026-06-20', '2026-06-21',
      // 22nd missed — run is 20 by now, so the second freeze is paid for
      '2026-06-23',
    ].map(day);
    const r = computeStreakState(earnedTwice, today, EARN_7);
    expect(r.days).toBe(21);
    expect(r.forgivenDays.map((d) => d.toISOString().slice(0, 10)).sort()).toEqual([
      '2026-06-08',
      '2026-06-22',
    ]);
  });

  it('never becomes unbreakable, however long the run', () => {
    // 60 qualifying days earns plenty — but spending them still costs seven days of
    // listening each, so two misses in a row end it regardless of what was banked.
    const long = Array.from({ length: 60 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 3, 1) + i * 86_400_000);
      return d;
    });
    const r = computeStreakState(long, today, EARN_7); // last day is far from today
    expect(r.days).toBe(0);
    expect(r.state).toBe('none');
  });

  it.each([
    ['freezeEarnEvery', { graceDays: 1, freezeEarnEvery: 0 }],
    ['graceDays', { graceDays: 0, freezeEarnEvery: 7 }],
  ])('is strict, never unlimited, when %s is zero', (_name, opts) => {
    const r = computeStreakState(['2026-06-21', '2026-06-23'].map(day), today, opts);
    expect(r.days).toBe(1);
    expect(r.forgivenDays).toEqual([]);
  });
});

/**
 * `dayStates` is what the calendar and the weekly strip render. It comes out of the
 * same pass as `days`, which is the point: a second predicate answering the same
 * date is how the calendar came to paint a day frozen while the number above it said
 * the streak had broken there.
 */
describe('walkStreak dayStates', () => {
  const GRACE = { graceDays: 1, freezeEarnEvery: 1 };

  it('labels every day from the first qualifying one to today', () => {
    const r = walkStreak(['2026-06-20', '2026-06-22', '2026-06-23'].map(day), today, GRACE);
    expect([...r.dayStates.entries()].sort()).toEqual([
      ['2026-06-20', 'burning'],
      ['2026-06-21', 'dimmed'],
      ['2026-06-22', 'burning'],
      ['2026-06-23', 'burning'],
    ]);
  });

  it('labels an unaffordable gap none, matching the streak it did not save', () => {
    const r = walkStreak(['2026-06-20', '2026-06-22', '2026-06-23'].map(day), today, {
      graceDays: 1,
      freezeEarnEvery: 7,
    });
    expect(r.dayStates.get('2026-06-21')).toBe('none');
    expect(r.days).toBe(2); // and the cell agrees with the number
  });

  it('cannot contradict `days`: the unbroken tail holds exactly that many burning days', () => {
    const dates = [
      '2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13',
      '2026-06-14', '2026-06-15', '2026-06-16', '2026-06-17',
      '2026-06-19', '2026-06-20', '2026-06-21', '2026-06-22', '2026-06-23',
    ].map(day);
    const r = walkStreak(dates, today, { graceDays: 1, freezeEarnEvery: 7 });

    let burning = 0;
    for (let d = today; ; d = new Date(d.getTime() - 86_400_000)) {
      const state = r.dayStates.get(d.toISOString().slice(0, 10));
      if (state === undefined || state === 'none') break;
      if (state === 'burning') burning += 1;
    }
    expect(burning).toBe(r.days);
  });
});
