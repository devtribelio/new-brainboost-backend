import { describe, it, expect } from 'vitest';
import { computeExpiry } from '@/modules/commerce/utils/compute-expiry';
import { env } from '@/config/env';

describe('computeExpiry', () => {
  const now = new Date('2026-05-13T10:00:00.000Z');

  it('cc → null (synchronous)', () => {
    expect(computeExpiry('cc', undefined, now)).toBeNull();
  });

  it('voucher → null', () => {
    expect(computeExpiry('voucher', undefined, now)).toBeNull();
  });

  it('va → +configured hours', () => {
    const r = computeExpiry('va', undefined, now);
    expect(r).not.toBeNull();
    expect(r!.getTime() - now.getTime()).toBe(env.commerce.vaExpiryHours * 3600 * 1000);
  });

  it('eWallet DANA → 30 min', () => {
    const r = computeExpiry('eWallet', 'DANA', now);
    expect(r!.getTime() - now.getTime()).toBe(env.commerce.ewalletExpiryMin.dana * 60 * 1000);
  });

  it('eWallet LINKAJA → 5 min', () => {
    const r = computeExpiry('eWallet', 'LINKAJA', now);
    expect(r!.getTime() - now.getTime()).toBe(env.commerce.ewalletExpiryMin.linkaja * 60 * 1000);
  });

  it('eWallet OVO → default 2 min', () => {
    const r = computeExpiry('eWallet', 'OVO', now);
    expect(r!.getTime() - now.getTime()).toBe(env.commerce.ewalletExpiryMin.default * 60 * 1000);
  });

  it('eWallet GOPAY → default 2 min', () => {
    const r = computeExpiry('eWallet', 'GOPAY', now);
    expect(r!.getTime() - now.getTime()).toBe(env.commerce.ewalletExpiryMin.default * 60 * 1000);
  });

  it('eWallet SHOPEEPAY → default 2 min', () => {
    const r = computeExpiry('eWallet', 'SHOPEEPAY', now);
    expect(r!.getTime() - now.getTime()).toBe(env.commerce.ewalletExpiryMin.default * 60 * 1000);
  });

  it('eWallet unknown → default 2 min', () => {
    const r = computeExpiry('eWallet', 'UNKNOWN', now);
    expect(r!.getTime() - now.getTime()).toBe(env.commerce.ewalletExpiryMin.default * 60 * 1000);
  });
});
