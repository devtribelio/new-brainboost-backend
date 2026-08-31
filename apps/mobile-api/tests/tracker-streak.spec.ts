import { describe, it, expect } from 'vitest';
import { computeStreak, computeStreakState } from '@/modules/tracker/tracker.streak';
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

describe('computeStreakState with grace', () => {
  const GRACE = 1;

  it('carries the streak over a single missed day and keeps counting on revival', () => {
    // Qualified through the 22nd, missed nothing, listened again today.
    const days = ['2026-06-20', '2026-06-21', '2026-06-23'].map(day); // gap on the 22nd
    const r = computeStreakState(days, today, GRACE);
    expect(r.days).toBe(3); // 23rd + 21st + 20th — the forgiven day is NOT counted
    expect(r.state).toBe('burning');
    expect(r.forgivenDays.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-06-22']);
  });

  it('reports dimmed while the missed day is still revivable', () => {
    // Missed yesterday, has not listened today yet.
    const days = ['2026-06-20', '2026-06-21'].map(day);
    const r = computeStreakState(days, today, GRACE);
    expect(r.days).toBe(2);
    expect(r.state).toBe('dimmed');
  });

  it('resets after two consecutive missed days', () => {
    const days = ['2026-06-19', '2026-06-20'].map(day); // 21st, 22nd, 23rd all missing
    const r = computeStreakState(days, today, GRACE);
    expect(r.days).toBe(0);
    expect(r.state).toBe('none');
  });

  it('does NOT forgive an old gap — grace is anchored on today, not on the gap', () => {
    // A streak broken back in May must stay broken, however the member has behaved
    // since: the streak is recomputed from raw sessions on every read, so a
    // gap-relative rule would revive months of history the moment grace ships.
    const days = ['2026-06-17', '2026-06-19', '2026-06-20', '2026-06-21', '2026-06-22'].map(day);
    const r = computeStreakState(days, today, GRACE); // gap on the 18th, far from today
    expect(r.days).toBe(4); // 22..19, stops at the 18th
    expect(r.state).toBe('at_risk');
  });

  it('is byte-identical to the strict walk when grace is off', () => {
    const days = ['2026-06-20', '2026-06-21'].map(day);
    expect(computeStreakState(days, today, 0).days).toBe(computeStreak(days, today));
    expect(computeStreakState(days, today, 0).state).toBe('none');
    expect(computeStreakState(days, today, 0).forgivenDays).toEqual([]);
  });

  it('marks at_risk when yesterday qualified but today has not yet', () => {
    const days = ['2026-06-21', '2026-06-22'].map(day);
    const r = computeStreakState(days, today, GRACE);
    expect(r.days).toBe(2);
    expect(r.state).toBe('at_risk');
  });
});
