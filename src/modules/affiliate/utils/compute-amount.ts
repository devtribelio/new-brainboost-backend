import { PBS_TIER_RATES, PBS_TIER2_THRESHOLD, PBS_TIER3_THRESHOLD, PERFORMANCE_SCHEMA, type PerformanceSchema } from '../constants';

/**
 * Formula kanonik dari legacy TBAffiliator::getPriceRecipient.
 * priceRecipient = floor((productPrice - voucherAmount) * rate / 100)
 *
 * Voucher di-clamp ke 0 kalau melebihi productPrice (no negative base).
 */
export function computeAmount(productPrice: number, voucherAmount: number, rate: number): number {
  const base = Math.max(productPrice - voucherAmount, 0);
  return Math.floor((base * rate) / 100);
}

/**
 * Tentukan PERFORMANCE tier + rate berdasarkan total lifetime commission.
 * Match legacy TBAffiliator::getPerformanceSchemaPercent — boundary inklusif (<=).
 */
export function getPerformanceTier(totalLifetime: number): { tier: 1 | 2 | 3; rate: number; schemaType: PerformanceSchema } {
  if (totalLifetime <= PBS_TIER2_THRESHOLD) {
    return { tier: 1, rate: PBS_TIER_RATES[0], schemaType: PERFORMANCE_SCHEMA.SCHEMA_1 };
  }
  if (totalLifetime <= PBS_TIER3_THRESHOLD) {
    return { tier: 2, rate: PBS_TIER_RATES[1], schemaType: PERFORMANCE_SCHEMA.SCHEMA_2 };
  }
  return { tier: 3, rate: PBS_TIER_RATES[2], schemaType: PERFORMANCE_SCHEMA.SCHEMA_3 };
}
