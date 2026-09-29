import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';

/**
 * PPN rate to bill a new order at, in percent. One place for every seller
 * (course checkout, course quote, event quote) so they can never disagree.
 *
 * Global today. Whether event tickets are taxable at all is a pending
 * finance/legal decision (docs/checkout-tax.md §6.2); when it lands as "no",
 * this is where a product-type branch returns 0 — callers do not change.
 */
export async function resolveTaxRate(): Promise<number> {
  const rate = await settingsService.getNumber(SETTING_KEYS.taxRate, 0);
  return rate > 0 ? rate : 0;
}
