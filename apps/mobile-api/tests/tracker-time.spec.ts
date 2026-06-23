import { describe, it, expect } from 'vitest';
import {
  toLocalDayWIB,
  weekStartMondayWIB,
  addDays,
  dayKey,
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
