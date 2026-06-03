import { describe, it, expect } from 'vitest';
import { computeNetAmount } from '@/modules/webhook/revenuecat.handler';

describe('computeNetAmount', () => {
  it('returns undefined when neither commission nor tax is provided', () => {
    expect(computeNetAmount(300_000)).toBeUndefined();
    expect(computeNetAmount(300_000, undefined, undefined)).toBeUndefined();
  });

  it('applies Apple 30% cut only (no tax)', () => {
    // 300_000 × 0.70 = 210_000
    expect(computeNetAmount(300_000, 3000)).toBe(210_000);
  });

  it('applies tax only (no commission)', () => {
    // 300_000 × 0.89 = 267_000
    expect(computeNetAmount(300_000, undefined, 1100)).toBe(267_000);
  });

  it('applies both commission and tax (multiplicative)', () => {
    // 300_000 × 0.70 × 0.89 = 186_900
    expect(computeNetAmount(300_000, 3000, 1100)).toBe(186_900);
  });

  it('small-business commission (15%)', () => {
    // 149_000 × 0.85 = 126_650
    expect(computeNetAmount(149_000, 1500)).toBe(126_650);
  });

  it('zero gross stays zero', () => {
    expect(computeNetAmount(0, 3000, 1100)).toBe(0);
  });

  it('clamps out-of-range percentages defensively', () => {
    // commission_percentage > 10000 (would mean >100%) → clamped to 10000 (net 0)
    expect(computeNetAmount(300_000, 999_999)).toBe(0);
    // negative percentages → clamped to 0 (no deduction)
    expect(computeNetAmount(300_000, -500, -500)).toBe(300_000);
  });

  it('floors fractional rupiah (no rounding up)', () => {
    // 100_001 × 0.7 = 70_000.7 → floor = 70_000
    expect(computeNetAmount(100_001, 3000)).toBe(70_000);
  });
});
