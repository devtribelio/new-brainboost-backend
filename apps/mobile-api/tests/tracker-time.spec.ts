import { describe, it, expect } from 'vitest';
import {
  toLocalDayWIB,
  toListeningDayWIB,
  weekStartMondayWIB,
  listeningDayEndsAt,
  addDays,
  dayKey,
  monthKey,
  monthBounds,
} from '@/modules/tracker/tracker.time';

describe('toLocalDayWIB', () => {
  it('keeps an instant before WIB midnight on the same WIB day', () => {
    // 16:30Z = 23:30 WIB on the 23rd (WIB midnight is 17:00Z).
    expect(dayKey(toLocalDayWIB(new Date('2026-06-23T16:30:00Z')))).toBe('2026-06-23');
  });

  it('rolls an instant after WIB midnight to the next WIB day', () => {
    // 17:30Z = 00:30 WIB on the 24th.
    expect(dayKey(toLocalDayWIB(new Date('2026-06-23T17:30:00Z')))).toBe('2026-06-24');
  });

  it('treats exactly 17:00Z as the start of the new WIB day', () => {
    expect(dayKey(toLocalDayWIB(new Date('2026-06-23T17:00:00Z')))).toBe('2026-06-24');
    expect(dayKey(toLocalDayWIB(new Date('2026-06-23T16:59:59Z')))).toBe('2026-06-23');
  });

  it('returns a UTC-midnight Date (matches @db.Date round-trip)', () => {
    const d = toLocalDayWIB(new Date('2026-06-23T10:00:00Z'));
    expect(d.toISOString()).toBe('2026-06-23T00:00:00.000Z');
  });
});

describe('toListeningDayWIB', () => {
  const day = (iso: string) => dayKey(toListeningDayWIB(new Date(iso)));

  it('keeps a session started just before midnight on that night', () => {
    // 16:59Z = 23:59 WIB on the 27th.
    expect(day('2026-08-27T16:59:00Z')).toBe('2026-08-27');
  });

  it('keeps a session started just after midnight on the SAME night', () => {
    // 17:30Z = 00:30 WIB on the 28th — still the night of the 27th.
    expect(day('2026-08-27T17:30:00Z')).toBe('2026-08-27');
  });

  it('rolls over exactly at 04:00 WIB', () => {
    expect(day('2026-08-27T20:59:59Z')).toBe('2026-08-27'); // 03:59:59 WIB 28th
    expect(day('2026-08-27T21:00:00Z')).toBe('2026-08-28'); // 04:00:00 WIB 28th
  });

  it('is unchanged from the calendar day for daytime listening', () => {
    // 05:00Z = 12:00 WIB — well inside the day either way.
    expect(day('2026-08-28T05:00:00Z')).toBe('2026-08-28');
    expect(day('2026-08-28T05:00:00Z')).toBe(dayKey(toLocalDayWIB(new Date('2026-08-28T05:00:00Z'))));
  });

  it('puts two consecutive nights on consecutive days (the Giska case)', () => {
    // Night 1 starts 26 Aug 23:48 WIB, night 2 starts 28 Aug 00:01 WIB.
    // Under a midnight boundary those are the 26th and the 28th — a false gap.
    expect(day('2026-08-26T16:48:00Z')).toBe('2026-08-26');
    expect(day('2026-08-27T17:01:00Z')).toBe('2026-08-27');
  });

  it('returns a UTC-midnight Date (matches @db.Date round-trip)', () => {
    expect(toListeningDayWIB(new Date('2026-08-28T05:00:00Z')).toISOString()).toBe(
      '2026-08-28T00:00:00.000Z',
    );
  });
});

describe('weekStartMondayWIB', () => {
  it('maps any day to the Monday of its week', () => {
    // 2026-06-23 is a Tuesday → Monday is 2026-06-22.
    expect(dayKey(weekStartMondayWIB(toLocalDayWIB(new Date('2026-06-23T10:00:00Z'))))).toBe(
      '2026-06-22',
    );
  });

  it('returns the same day when given a Monday', () => {
    const monday = toLocalDayWIB(new Date('2026-06-22T10:00:00Z'));
    expect(dayKey(weekStartMondayWIB(monday))).toBe('2026-06-22');
  });

  it('maps Sunday back to the preceding Monday', () => {
    // 2026-06-28 is a Sunday → Monday is 2026-06-22.
    expect(dayKey(weekStartMondayWIB(toLocalDayWIB(new Date('2026-06-28T10:00:00Z'))))).toBe(
      '2026-06-22',
    );
  });
});

describe('addDays', () => {
  it('shifts a UTC-midnight day by whole days', () => {
    const base = toLocalDayWIB(new Date('2026-06-23T10:00:00Z'));
    expect(dayKey(addDays(base, -1))).toBe('2026-06-22');
    expect(dayKey(addDays(base, 3))).toBe('2026-06-26');
  });
});

describe('listeningDayEndsAt', () => {
  it('closes a listening day one second before the next 04:00 WIB', () => {
    expect(listeningDayEndsAt(toListeningDayWIB(new Date('2026-08-28T05:00:00Z')))).toBe(
      '2026-08-29T03:59:59+07:00',
    );
  });
});

describe('monthKey / monthBounds', () => {
  it('derives the month key from a listening day', () => {
    expect(monthKey(toListeningDayWIB(new Date('2026-09-04T05:00:00Z')))).toBe('2026-09');
    // 00:30 WIB on the 1st still belongs to the previous listening day — and so to
    // the previous MONTH. The calendar pages on this, so getting it wrong would hide
    // a night of listening from both months.
    expect(monthKey(toListeningDayWIB(new Date('2026-09-30T17:30:00Z')))).toBe('2026-09');
  });

  it('spans a 30-day month, a 31-day month and December', () => {
    expect(dayKey(monthBounds('2026-09').start)).toBe('2026-09-01');
    expect(dayKey(monthBounds('2026-09').end)).toBe('2026-09-30');
    expect(dayKey(monthBounds('2026-01').end)).toBe('2026-01-31');
    expect(dayKey(monthBounds('2026-12').end)).toBe('2026-12-31'); // must not roll into 2027
  });

  it('gets February right in a common and a leap year', () => {
    expect(dayKey(monthBounds('2026-02').end)).toBe('2026-02-28');
    expect(dayKey(monthBounds('2028-02').end)).toBe('2028-02-29');
  });

  it('produces a range that walks with addDays and closes on the last day', () => {
    const { start, end } = monthBounds('2026-02');
    let n = 0;
    for (let d = start; d.getTime() <= end.getTime(); d = addDays(d, 1)) n += 1;
    expect(n).toBe(28);
  });
});
