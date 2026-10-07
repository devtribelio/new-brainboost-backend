export interface ComputeTotalsInput {
  unitPrice: number;
  qty?: number;
  /**
   * Pre-computed line total, for a seller whose price is not `unitPrice × qty` —
   * event tickets with a bundle ladder (`computeTicketItemTotal`). Omitted, the
   * multiplication below stands, so course checkout is untouched.
   *
   * Passed in rather than computed here on purpose: the ladder lives in the event
   * domain, and teaching this function about it would drag ticket pricing into
   * every order that has nothing to do with events.
   */
  itemTotal?: number;
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
  /**
   * PPN in percent (11 = 11%). Omitted or 0 = no tax, and the result is then
   * byte-identical to the pre-tax function. Applied to
   * `itemTotal − voucherAmount − prorationCredit` — the bill the buyer actually
   * faces — never to the catalog price.
   */
  taxRate?: number;
}

export interface ComputeTotalsResult {
  itemTotal: number;
  voucherAmount: number;
  /** Credit actually applied — never more than what is left after the voucher. */
  prorationCredit: number;
  /** Percent, echoed so the client can label the line ("PPN 11%"). */
  taxRate: number;
  /** Whole rupiah, half-up. 0 whenever `taxRate` is 0 or nothing is left to tax. */
  taxAmount: number;
  /** Tax-inclusive: what goes on the invoice. */
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
 * A PERCENT voucher therefore discounts the BUNDLED total when one is supplied —
 * the bill the buyer actually faces, not a notional `unitPrice × qty`.
 *
 * Tax comes LAST, on `itemTotal − voucherAmount − prorationCredit`: a 100% voucher
 * or a TRIAL leaves nothing to tax, so those orders still settle at 0 through the
 * voucher-bypass path, and a tier upgrade is taxed on what the member actually
 * pays (the credited term was taxed when it was sold). Rounding is half-up (`Math.round` on a non-negative number); the product
 * is taken before the single division so an exact .5 stays exact.
 *
 * Legacy parity: `priceRecipient` uses floor((max(productPrice - voucherAmount, 0)) * rate / 100)
 * — voucher is subtracted from itemTotal before fee in this function.
 */
export function computeTotals(input: ComputeTotalsInput): ComputeTotalsResult {
  const qty = Math.max(1, Math.floor(input.qty ?? 1));
  const itemTotal = input.itemTotal ?? input.unitPrice * qty;

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

  const taxBase = afterVoucher - prorationCredit;
  const taxRate = input.taxRate != null && input.taxRate > 0 ? input.taxRate : 0;
  const taxAmount = Math.round((taxBase * taxRate) / 100);
  const amount = taxBase + taxAmount;
  return { itemTotal, voucherAmount, prorationCredit, taxRate, taxAmount, amount };
}
