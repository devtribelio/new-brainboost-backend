export interface ComputeTotalsInput {
  unitPrice: number;
  qty?: number;
  voucher?:
    | {
        type: 'PERCENT' | 'AMOUNT' | 'TRIAL';
        value: number;
        maxAmount?: number | null;
      }
    | null;
  /**
   * Unused portion of a running subscription term, credited on an upgrade.
   * Applied AFTER the voucher, against whatever is left — the two stack rather
   * than compete, and neither can push the order below zero.
   */
  prorationCredit?: number;
}

export interface ComputeTotalsResult {
  itemTotal: number;
  voucherAmount: number;
  /** Credit actually applied — never more than what is left after the voucher. */
  prorationCredit: number;
  amount: number;
}

/**
 * Pure: compute order totals before payment + fee.
 * Voucher rules:
 *  - PERCENT: floor(itemTotal * value / 100), capped at maxAmount when set.
 *  - AMOUNT: flat IDR discount.
 *  - TRIAL: always 100% — a free trial settles as an amount=0 order through the
 *    existing voucher-bypass path, and `value` is not a discount for this type.
 *    Handled explicitly: falling through to the AMOUNT branch would read `value`
 *    (0 on a trial row) and silently charge the member full price.
 *  - Voucher discount cannot exceed itemTotal (clamp to itemTotal).
 *
 * Legacy parity: `priceRecipient` uses floor((max(productPrice - voucherAmount, 0)) * rate / 100)
 * — voucher is subtracted from itemTotal before fee in this function.
 */
export function computeTotals(input: ComputeTotalsInput): ComputeTotalsResult {
  const qty = Math.max(1, Math.floor(input.qty ?? 1));
  const itemTotal = input.unitPrice * qty;

  let voucherAmount = 0;
  if (input.voucher) {
    if (input.voucher.type === 'TRIAL') {
      voucherAmount = itemTotal;
    } else if (input.voucher.type === 'PERCENT') {
      const raw = Math.floor((itemTotal * input.voucher.value) / 100);
      voucherAmount = input.voucher.maxAmount != null ? Math.min(raw, input.voucher.maxAmount) : raw;
    } else {
      voucherAmount = input.voucher.value;
    }
    if (voucherAmount > itemTotal) voucherAmount = itemTotal;
    if (voucherAmount < 0) voucherAmount = 0;
  }

  const afterVoucher = Math.max(0, itemTotal - voucherAmount);
  const prorationCredit = Math.min(Math.max(input.prorationCredit ?? 0, 0), afterVoucher);

  const amount = afterVoucher - prorationCredit;
  return { itemTotal, voucherAmount, prorationCredit, amount };
}
