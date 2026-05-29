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
 */
export function quoteDisbursement(balance: number): DisbursementQuote {
  const fee = DISBURSEMENT_FEE;
  const grossAmount = Math.max(0, Math.floor(balance));
  const netAmount = grossAmount - fee;

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
