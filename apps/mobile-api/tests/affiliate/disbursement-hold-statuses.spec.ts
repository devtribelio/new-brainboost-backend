/**
 * Pure unit guard for the money-correctness invariant: which disbursement
 * statuses HOLD (consume) withdrawable balance. Runs with NO database.
 *
 * getWithdrawableBalance subtracts disbursement.grossAmount ONLY for statuses in
 * DISBURSEMENT_HOLD_STATUSES. If a terminal-failure status ever leaks into this
 * set, a rejected/failed payout would permanently eat the member's balance —
 * this test prevents that regression.
 */
import { describe, it, expect } from 'vitest';
import {
  DISBURSEMENT_HOLD_STATUSES,
  DISBURSEMENT_STATUS,
} from '@bb/domain/affiliate/constants';

describe('DISBURSEMENT_HOLD_STATUSES (balance-hold invariant)', () => {
  const hold = new Set<string>(DISBURSEMENT_HOLD_STATUSES as readonly string[]);

  it('HOLDS in-flight + paid (these subtract from withdrawable balance)', () => {
    expect(hold.has(DISBURSEMENT_STATUS.PENDING)).toBe(true);
    expect(hold.has(DISBURSEMENT_STATUS.PROCESSING)).toBe(true);
    expect(hold.has(DISBURSEMENT_STATUS.PAID)).toBe(true);
  });

  it('NEVER holds terminal-failure statuses (these free the balance)', () => {
    expect(hold.has(DISBURSEMENT_STATUS.FAILED)).toBe(false);
    expect(hold.has(DISBURSEMENT_STATUS.REJECTED)).toBe(false);
    expect(hold.has(DISBURSEMENT_STATUS.VOIDED)).toBe(false);
  });

  it('holds exactly three statuses (no accidental additions)', () => {
    expect(DISBURSEMENT_HOLD_STATUSES.length).toBe(3);
  });
});
