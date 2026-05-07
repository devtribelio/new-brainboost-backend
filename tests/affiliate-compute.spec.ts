import { describe, it, expect } from 'vitest';
import { computeAmount, getPerformanceTier } from '@/modules/affiliate/utils/compute-amount';
import { PBS_TIER2_THRESHOLD, PBS_TIER3_THRESHOLD } from '@/modules/affiliate/constants';

describe('computeAmount', () => {
  it('PERCENT 20% on Rp 1jt = Rp 200K', () => {
    expect(computeAmount(1_000_000, 0, 20)).toBe(200_000);
  });

  it('subtracts voucher before computing', () => {
    expect(computeAmount(1_000_000, 200_000, 20)).toBe(160_000);
  });

  it('clamps voucher to product price (no negative base)', () => {
    expect(computeAmount(100_000, 200_000, 20)).toBe(0);
  });

  it('floors result (no fractional rupiah)', () => {
    expect(computeAmount(99_999, 0, 20)).toBe(19_999);
  });

  it('rate 0 returns 0', () => {
    expect(computeAmount(1_000_000, 0, 0)).toBe(0);
  });

  it('rate 100 returns full base', () => {
    expect(computeAmount(500_000, 0, 100)).toBe(500_000);
  });
});

describe('getPerformanceTier', () => {
  it('lifetime 0 → tier 1 (20%)', () => {
    expect(getPerformanceTier(0)).toEqual({ tier: 1, rate: 20, schemaType: 'SCHEMA_1' });
  });

  it('lifetime exactly threshold (5M) → tier 1 (boundary inclusive)', () => {
    expect(getPerformanceTier(PBS_TIER2_THRESHOLD)).toEqual({ tier: 1, rate: 20, schemaType: 'SCHEMA_1' });
  });

  it('lifetime threshold + 1 → tier 2 (30%)', () => {
    expect(getPerformanceTier(PBS_TIER2_THRESHOLD + 1)).toEqual({ tier: 2, rate: 30, schemaType: 'SCHEMA_2' });
  });

  it('lifetime exactly threshold (15M) → tier 2 (boundary inclusive)', () => {
    expect(getPerformanceTier(PBS_TIER3_THRESHOLD)).toEqual({ tier: 2, rate: 30, schemaType: 'SCHEMA_2' });
  });

  it('lifetime threshold + 1 → tier 3 (40%)', () => {
    expect(getPerformanceTier(PBS_TIER3_THRESHOLD + 1)).toEqual({ tier: 3, rate: 40, schemaType: 'SCHEMA_3' });
  });

  it('lifetime 1B → tier 3', () => {
    expect(getPerformanceTier(1_000_000_000)).toEqual({ tier: 3, rate: 40, schemaType: 'SCHEMA_3' });
  });
});
