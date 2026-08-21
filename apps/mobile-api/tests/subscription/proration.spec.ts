/**
 * Upgrade proration: credit the unused term, charge the new plan's full price.
 * Table-driven — pure function, no DB.
 */
import { describe, it, expect } from 'vitest';
import { computeProration } from '@bb/domain/subscription/proration';

const SOLO = 999_000;
const FAMILY = 1_999_000;

/** Term that started `daysIn` days ago and runs 365 days. */
function term(daysIn: number) {
  const now = new Date('2026-06-01T00:00:00.000Z');
  const expiresAt = new Date(now.getTime() + (365 - daysIn) * 24 * 3600 * 1000);
  return { now, expiresAt, periodMonths: 12 };
}

describe('computeProration', () => {
  it('matches the worked example: Solo → Family, 100 days into a 365 day term', () => {
    const { now, expiresAt, periodMonths } = term(100);
    const res = computeProration({
      oldPrice: SOLO,
      newPrice: FAMILY,
      expiresAt,
      periodMonths,
      now,
    });
    expect(res.remainingDays).toBe(265);
    expect(res.credit).toBe(Math.floor((SOLO * 265) / res.termDays));
    expect(res.charge).toBe(FAMILY - res.credit);
  });

  it('an untouched term credits nearly the whole old plan', () => {
    const { now, expiresAt, periodMonths } = term(0);
    const res = computeProration({ oldPrice: SOLO, newPrice: FAMILY, expiresAt, periodMonths, now });
    expect(res.credit).toBe(SOLO);
    expect(res.charge).toBe(FAMILY - SOLO);
  });

  it('a member in grace has no remaining days, so it collapses into a plain renewal', () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const expiresAt = new Date(now.getTime() - 3 * 24 * 3600 * 1000); // expired, in grace
    const res = computeProration({
      oldPrice: SOLO,
      newPrice: FAMILY,
      expiresAt,
      periodMonths: 12,
      now,
    });
    expect(res.remainingDays).toBe(0);
    expect(res.credit).toBe(0);
    expect(res.charge).toBe(FAMILY);
  });

  it('never charges below zero, even when the credit exceeds the new price', () => {
    const { now, expiresAt, periodMonths } = term(0);
    const res = computeProration({
      oldPrice: FAMILY,
      newPrice: SOLO, // not a real upgrade — the clamp is the guard, not the ordering
      expiresAt,
      periodMonths,
      now,
    });
    expect(res.charge).toBe(0);
  });

  it('rounds once at the end — credit + charge always equals the new price', () => {
    for (const daysIn of [1, 37, 99, 200, 364]) {
      const { now, expiresAt, periodMonths } = term(daysIn);
      const res = computeProration({
        oldPrice: SOLO,
        newPrice: FAMILY,
        expiresAt,
        periodMonths,
        now,
      });
      expect(res.credit + res.charge).toBe(FAMILY);
      expect(Number.isInteger(res.credit)).toBe(true);
    }
  });
});
