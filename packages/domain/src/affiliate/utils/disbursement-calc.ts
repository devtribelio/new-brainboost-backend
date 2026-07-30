import { ERROR_CODES, type ErrorCode } from '@bb/common/exceptions';
import { DISBURSEMENT_FEE, DISBURSEMENT_MIN_BALANCE, DISBURSEMENT_MIN_NET } from '../constants';

export interface DisbursementQuote {
  eligible: boolean;
  /**
   * Why the quote is ineligible, as an error code — NOT a sentence. Callers turn
   * it into copy via `messageFor()` (display) or throw it (API error), so the
   * wording lives in one place. The amounts the old English strings interpolated
   * are already returned separately (`grossAmount`/`fee`/`netAmount`, plus
   * `minBalance` from getSummary), so no number is lost.
   */
  reasonCode?: ErrorCode;
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
 *
 * `minBalance` (optional) overrides the minimum gross to withdraw — callers pass the
 * runtime value from app_settings `disbursement.minBalance`; defaults to the constant.
 *
 * `fee` (optional) overrides the flat platform fee — callers pass the runtime value
 * from app_settings `disbursement.fee`; defaults to the constant.
 */
export function quoteDisbursement(
  balance: number,
  requestedAmount?: number,
  minBalance: number = DISBURSEMENT_MIN_BALANCE,
  fee: number = DISBURSEMENT_FEE,
): DisbursementQuote {
  const available = Math.max(0, Math.floor(balance));
  const grossAmount =
    requestedAmount === undefined ? available : Math.max(0, Math.floor(requestedAmount));
  const netAmount = grossAmount - fee;

  if (requestedAmount !== undefined && grossAmount > available) {
    return {
      eligible: false,
      reasonCode: ERROR_CODES.DISBURSEMENT_AMOUNT_EXCEEDS_BALANCE,
      grossAmount,
      fee,
      netAmount,
    };
  }
  if (grossAmount < minBalance) {
    return {
      eligible: false,
      reasonCode: ERROR_CODES.DISBURSEMENT_BELOW_MIN_BALANCE,
      grossAmount,
      fee,
      netAmount,
    };
  }
  if (netAmount <= DISBURSEMENT_MIN_NET) {
    return {
      eligible: false,
      reasonCode: ERROR_CODES.DISBURSEMENT_NET_TOO_SMALL,
      grossAmount,
      fee,
      netAmount,
    };
  }
  return { eligible: true, grossAmount, fee, netAmount };
}
