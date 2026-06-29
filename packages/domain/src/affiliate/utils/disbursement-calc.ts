import { DISBURSEMENT_FEE, DISBURSEMENT_MIN_BALANCE, DISBURSEMENT_MIN_NET } from '../constants';

export interface DisbursementQuote {
  eligible: boolean;
  reason?: string;
  grossAmount: number; // balance consumed by the payout
  fee: number; // flat platform fee
  netAmount: number; // paid to the member = gross - fee
}

/**
 * Pure decision: given a withdrawable balance, compute payout amounts + eligibility.
 * Legacy rules (TBDisbursement::affiliate): balance >= 15,000; flat fee 5,000;
 * net (balance - fee) must STRICTLY exceed 10,000.
 *
 * `requestedAmount` (optional) = the gross the member wants to withdraw. When
 * given, it becomes the payout gross (must be <= available balance and still
 * clear the min-balance / min-net rules). When omitted, the full balance is used.
 */
export function quoteDisbursement(balance: number, requestedAmount?: number): DisbursementQuote {
  const fee = DISBURSEMENT_FEE;
  const available = Math.max(0, Math.floor(balance));
  const grossAmount = requestedAmount === undefined ? available : Math.max(0, Math.floor(requestedAmount));
  const netAmount = grossAmount - fee;

  if (requestedAmount !== undefined && grossAmount > available) {
    return {
      eligible: false,
      reason: `Amount exceeds withdrawable balance (${available})`,
      grossAmount,
      fee,
      netAmount,
    };
  }
  if (grossAmount < DISBURSEMENT_MIN_BALANCE) {
    return {
      eligible: false,
      reason: `Minimum balance to withdraw is ${DISBURSEMENT_MIN_BALANCE}`,
      grossAmount,
      fee,
      netAmount,
    };
  }
  if (netAmount <= DISBURSEMENT_MIN_NET) {
    return {
      eligible: false,
      reason: `Net payout must exceed ${DISBURSEMENT_MIN_NET}`,
      grossAmount,
      fee,
      netAmount,
    };
  }
  return { eligible: true, grossAmount, fee, netAmount };
}
