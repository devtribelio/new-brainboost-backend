import { describe, it, expect } from 'vitest';
import { quoteDisbursement } from '@bb/domain/affiliate/utils/disbursement-calc';
import {
  DISBURSEMENT_FEE,
  DISBURSEMENT_MIN_BALANCE,
  DISBURSEMENT_MIN_NET,
} from '@bb/domain/affiliate/constants';

describe('quoteDisbursement (legacy payout rules)', () => {
  it('rejects balance below the minimum (15k)', () => {
    const q = quoteDisbursement(DISBURSEMENT_MIN_BALANCE - 1);
    expect(q.eligible).toBe(false);
    expect(q.reason).toMatch(/Minimum balance/);
  });

  it('rejects when net (balance - fee) does not exceed 10k — exactly at the floor', () => {
    // 15,000 - 5,000 = 10,000 which is NOT > 10,000 → ineligible (legacy: must exceed)
    const q = quoteDisbursement(15_000);
    expect(q.eligible).toBe(false);
    expect(q.netAmount).toBe(10_000);
    expect(q.reason).toMatch(/Net payout/);
  });

  it('accepts the first eligible amount (15,001 → net 10,001)', () => {
    const q = quoteDisbursement(15_001);
    expect(q.eligible).toBe(true);
    expect(q.fee).toBe(DISBURSEMENT_FEE);
    expect(q.grossAmount).toBe(15_001);
    expect(q.netAmount).toBe(10_001);
  });

  it('computes net = gross - fee for a typical balance', () => {
    const q = quoteDisbursement(50_000);
    expect(q).toEqual({ eligible: true, grossAmount: 50_000, fee: 5_000, netAmount: 45_000 });
  });

  it('floors fractional balances and never goes negative', () => {
    expect(quoteDisbursement(50_000.9).grossAmount).toBe(50_000);
    const zero = quoteDisbursement(-100);
    expect(zero.grossAmount).toBe(0);
    expect(zero.eligible).toBe(false);
  });

  it('thresholds are wired from constants', () => {
    expect(DISBURSEMENT_MIN_BALANCE).toBe(15_000);
    expect(DISBURSEMENT_MIN_NET).toBe(10_000);
    expect(DISBURSEMENT_FEE).toBe(5_000);
  });

  describe('partial amount (requestedAmount)', () => {
    it('uses the requested amount as gross, not the full balance', () => {
      const q = quoteDisbursement(100_000, 30_000);
      expect(q).toEqual({ eligible: true, grossAmount: 30_000, fee: 5_000, netAmount: 25_000 });
    });

    it('rejects an amount above the withdrawable balance', () => {
      const q = quoteDisbursement(20_000, 30_000);
      expect(q.eligible).toBe(false);
      expect(q.reason).toMatch(/exceeds withdrawable balance/);
    });

    it('allows withdrawing exactly the full balance', () => {
      const q = quoteDisbursement(50_000, 50_000);
      expect(q.eligible).toBe(true);
      expect(q.grossAmount).toBe(50_000);
    });

    it('still enforces the min-balance rule on the requested amount', () => {
      const q = quoteDisbursement(100_000, DISBURSEMENT_MIN_BALANCE - 1);
      expect(q.eligible).toBe(false);
      expect(q.reason).toMatch(/Minimum balance/);
    });

    it('still enforces the min-net rule on the requested amount', () => {
      const q = quoteDisbursement(100_000, 15_000);
      expect(q.eligible).toBe(false);
      expect(q.netAmount).toBe(10_000);
      expect(q.reason).toMatch(/Net payout/);
    });

    it('floors a fractional requested amount', () => {
      expect(quoteDisbursement(100_000, 30_000.9).grossAmount).toBe(30_000);
    });

    it('omitting the amount keeps full-balance behavior', () => {
      expect(quoteDisbursement(50_000)).toEqual(quoteDisbursement(50_000, 50_000));
    });
  });
});
