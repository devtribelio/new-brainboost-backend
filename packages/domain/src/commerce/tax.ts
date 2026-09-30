import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { isEventTicketOrder } from '@bb/domain/event/order';

/**
 * PPN rate to bill a new order at, in percent. One place for every seller
 * (course checkout, course quote, event quote, RevenueCat ingest) so they can
 * never disagree. `tax.enabled` is checked first: off means 0 whatever the
 * configured rate, so ops can stage the rate before go-live and switch tax
 * off with one flip that keeps the rate.
 *
 * Event tickets are NOT taxed (decided 2026-09-30): a ticket is not the same
 * taxable object as a course — entertainment falls under regional PBJT rather
 * than PPN — so a ticket order resolves to 0 whatever `tax.rate` says. The
 * product type is read here rather than passed in as a flag, for the same
 * reason `isEventTicketOrder` exists: an optional "isEvent" input reads as
 * "not an event" to any caller that forgets it, and that failure bills tax.
 */
export async function resolveTaxRate(productId: string): Promise<number> {
  if (!(await settingsService.getBoolean(SETTING_KEYS.taxEnabled, false))) return 0;
  if (await isEventTicketOrder(productId)) return 0;
  const rate = await settingsService.getNumber(SETTING_KEYS.taxRate, 0);
  return rate > 0 ? rate : 0;
}