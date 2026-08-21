/**
 * Tier ordering, shared by every caller that has to know which way a plan
 * change goes: the RevenueCat webhook (defer a downgrade, apply an upgrade),
 * checkout (which switches web is allowed to sell), and the pending-change
 * endpoints.
 *
 * Seat count is the primary key because it is what makes a downgrade
 * destructive — someone loses access. Price only breaks ties between tiers that
 * share a seat count. Phase 2/3 add non-annual plans, where a SOLO_6M and a
 * SOLO_12M compare equal and land on "not a change of tier"; that is deliberate
 * for now (period changes are not a supported switch), and the day they are, a
 * plan needs an explicit rank rather than this pair.
 */
export interface TierRef {
  seatCount: number;
  price: number;
}

export function isDowngrade(from: TierRef, to: TierRef): boolean {
  if (to.seatCount !== from.seatCount) return to.seatCount < from.seatCount;
  return to.price < from.price;
}

export function isUpgrade(from: TierRef, to: TierRef): boolean {
  if (to.seatCount !== from.seatCount) return to.seatCount > from.seatCount;
  return to.price > from.price;
}
