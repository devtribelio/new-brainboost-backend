export interface ComputeTotalsInput {
  unitPrice: number;
  qty?: number;
  voucher?:
    | {
        type: 'PERCENT' | 'AMOUNT';
        value: number;
        maxAmount?: number | null;
      }
    | null;
}

export interface ComputeTotalsResult {
  itemTotal: number;
  voucherAmount: number;
  amount: number;
}

/**
 * Pure: compute order totals before payment + fee.
 * Voucher rules:
 *  - PERCENT: floor(itemTotal * value / 100), capped at maxAmount when set.
 *  - AMOUNT: flat IDR discount.
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
    if (input.voucher.type === 'PERCENT') {
      const raw = Math.floor((itemTotal * input.voucher.value) / 100);
      voucherAmount = input.voucher.maxAmount != null ? Math.min(raw, input.voucher.maxAmount) : raw;
    } else {
      voucherAmount = input.voucher.value;
    }
    if (voucherAmount > itemTotal) voucherAmount = itemTotal;
    if (voucherAmount < 0) voucherAmount = 0;
  }

  const amount = Math.max(0, itemTotal - voucherAmount);
  return { itemTotal, voucherAmount, amount };
}
