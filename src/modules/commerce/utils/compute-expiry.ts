import { env } from '@/config/env';
import type { CommercePaymentTypeLiteral, EwalletType } from '../constants';

/**
 * Pure: compute payment expiry per gateway.
 * Legacy parity (TBCommerce::payment):
 *   - VA: +24h
 *   - DANA: +30m
 *   - LINKAJA: +5m
 *   - OVO / GOPAY / SHOPEEPAY (default): +2m
 *   - CC: immediate (no expiry — synchronous result)
 *   - voucher: immediate
 */
export function computeExpiry(
  paymentType: CommercePaymentTypeLiteral,
  ewalletType?: string,
  now: Date = new Date(),
): Date | null {
  if (paymentType === 'cc' || paymentType === 'voucher') return null;
  if (paymentType === 'va') {
    return addHours(now, env.commerce.vaExpiryHours);
  }
  if (paymentType === 'eWallet') {
    const min = resolveEwalletMinutes(ewalletType as EwalletType | undefined);
    return addMinutes(now, min);
  }
  return null;
}

function resolveEwalletMinutes(type?: EwalletType): number {
  switch (type) {
    case 'DANA':
      return env.commerce.ewalletExpiryMin.dana;
    case 'LINKAJA':
      return env.commerce.ewalletExpiryMin.linkaja;
    case 'OVO':
    case 'GOPAY':
    case 'SHOPEEPAY':
    default:
      return env.commerce.ewalletExpiryMin.default;
  }
}

function addHours(d: Date, h: number): Date {
  return new Date(d.getTime() + h * 3600 * 1000);
}

function addMinutes(d: Date, m: number): Date {
  return new Date(d.getTime() + m * 60 * 1000);
}
