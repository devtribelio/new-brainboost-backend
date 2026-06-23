import { describe, it, expect } from 'vitest';
import { computeStreak } from '@/modules/tracker/tracker.streak';
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
