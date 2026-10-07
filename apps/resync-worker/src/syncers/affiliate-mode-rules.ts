/**
 * Provenance gate for `members.affiliateBased` (audit 08 F8).
 *
 * The new app lets a member switch PERFORMANCE/GROWTH (`AffiliatorService.setMode`), but the
 * legacy tree resync used to overwrite the mode unconditionally — so a mode chosen in the app
 * was reverted the next time the member's `member_network` row was touched, and the next
 * purchase was paid on the wrong scheme.
 *
 * `members.affiliate_based_source` records who set it:
 *   'LEGACY' = migration / tree resync (`member_network.affiliate_based`)
 *   'APP'    = member switched mode in the app
 *   NULL     = unknown
 * The tree may only write over NULL / 'LEGACY', never 'APP'.
 */

export const AFFILIATE_BASED_SOURCE = {
  LEGACY: 'LEGACY',
  APP: 'APP',
} as const;

export function mayOverwriteAffiliateBased(currentSource: string | null): boolean {
  return currentSource === null || currentSource === AFFILIATE_BASED_SOURCE.LEGACY;
}
