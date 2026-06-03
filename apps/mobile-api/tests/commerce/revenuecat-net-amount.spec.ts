import { describe, it, expect } from 'vitest';
import { computeNetAmount } from '@/modules/webhook/revenuecat.handler';

describe('computeNetAmount', () => {
  it('returns undefined when neither commission nor tax is provided', () => {
    expect(computeNetAmount(300_000)).toBeUndefined();
    expect(computeNetAmount(300_000, undefined, undefined)).toBeUndefined();
  });

  it('applies Apple 30% cut only (no tax)', () => {
    // 300_000 × 0.70 = 210_000
    expect(computeNetAmount(300_000, 0.3)).toBe(210_000);
  });

  it('applies tax only (no commission)', () => {
    // 300_000 × 0.89 = 267_000
    expect(computeNetAmount(300_000, undefined, 0.11)).toBe(267_000);
  });

  it('applies both commission and tax (multiplicative)', () => {
    // 300_000 × 0.70 × 0.89 = 186_900
    expect(computeNetAmount(300_000, 0.3, 0.11)).toBe(186_900);
  });

  it('small-business commission (15%)', () => {
    // 149_000 × 0.85 = 126_650
    expect(computeNetAmount(149_000, 0.15)).toBe(126_650);
  });

  it('reproduces the production sample (429k, 30% cut, 7% tax) → 279_279', () => {
    // Matches the row that prompted the encoding fix: previous buggy formula
    // returned 428_984 (off by 16 IDR instead of ~30% cut).
    expect(computeNetAmount(429_000, 0.3, 0.07)).toBe(279_279);
  });

  it('zero gross stays zero', () => {
    expect(computeNetAmount(0, 0.3, 0.11)).toBe(0);
  });

  it('clamps out-of-range fractions defensively', () => {
    // commission > 1 (would mean >100%) → clamped to 1 → net 0
    expect(computeNetAmount(300_000, 99)).toBe(0);
    // negative → clamped to 0 → no deduction
    expect(computeNetAmount(300_000, -0.5, -0.5)).toBe(300_000);
  });

  it('floors fractional rupiah (no rounding up)', () => {
    // 100_001 × 0.7 = 70_000.7 → floor = 70_000
    expect(computeNetAmount(100_001, 0.3)).toBe(70_000);
  });
});
