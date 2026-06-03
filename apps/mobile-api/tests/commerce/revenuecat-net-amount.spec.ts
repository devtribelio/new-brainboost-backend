import { describe, it, expect } from 'vitest';
import { computeNetAmount } from '@/modules/webhook/revenuecat.handler';

describe('computeNetAmount', () => {
  it('returns undefined when no fields are provided', () => {
    expect(computeNetAmount(300_000)).toBeUndefined();
    expect(computeNetAmount(300_000, undefined, undefined, undefined)).toBeUndefined();
  });

  describe('takehome_percentage path (preferred — RC precomputed)', () => {
    it('uses takehome directly, ignoring commission/tax', () => {
      // Real ID sandbox event: gross 429k, takehome 0.7 → net 300_300.
      // RC's 0.7 ≠ (1 - 0.2703) × (1 - 0.0991) because tax in ID is
      // consumer-paid, not deducted from dev share — takehome is the truth.
      expect(computeNetAmount(429_000, 0.7, 0.2703, 0.0991)).toBe(300_300);
    });

    it('70% takehome on 300k → 210k', () => {
      expect(computeNetAmount(300_000, 0.7)).toBe(210_000);
    });

    it('85% takehome (small business) on 149k → 126_650', () => {
      expect(computeNetAmount(149_000, 0.85)).toBe(126_650);
    });

    it('takehome=0 → net 0', () => {
      expect(computeNetAmount(429_000, 0)).toBe(0);
    });

    it('clamps takehome > 1 to 1 (caps at gross)', () => {
      expect(computeNetAmount(100_000, 1.5)).toBe(100_000);
    });

    it('clamps negative takehome to 0', () => {
      expect(computeNetAmount(100_000, -0.5)).toBe(0);
    });
  });

  describe('fallback path: commission/tax multiplicative (when takehome absent)', () => {
    it('commission only', () => {
      // 300_000 × 0.70 = 210_000
      expect(computeNetAmount(300_000, undefined, 0.3)).toBe(210_000);
    });

    it('tax only', () => {
      // 300_000 × 0.89 = 267_000
      expect(computeNetAmount(300_000, undefined, undefined, 0.11)).toBe(267_000);
    });

    it('both commission and tax (multiplicative)', () => {
      // 300_000 × 0.70 × 0.89 = 186_900
      expect(computeNetAmount(300_000, undefined, 0.3, 0.11)).toBe(186_900);
    });

    it('clamps out-of-range fractions', () => {
      expect(computeNetAmount(300_000, undefined, 99)).toBe(0);
      expect(computeNetAmount(300_000, undefined, -0.5, -0.5)).toBe(300_000);
    });
  });

  it('zero gross stays zero', () => {
    expect(computeNetAmount(0, 0.7)).toBe(0);
    expect(computeNetAmount(0, undefined, 0.3, 0.11)).toBe(0);
  });

  it('floors fractional rupiah (no rounding up)', () => {
    // 100_001 × 0.7 = 70_000.7 → floor = 70_000
    expect(computeNetAmount(100_001, 0.7)).toBe(70_000);
  });
});
