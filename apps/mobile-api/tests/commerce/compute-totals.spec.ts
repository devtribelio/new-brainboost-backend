import { describe, it, expect } from 'vitest';
import { computeTotals } from '@bb/domain/commerce/utils/compute-totals';

describe('computeTotals', () => {
  it('no voucher: amount = itemTotal', () => {
    const r = computeTotals({ unitPrice: 500_000 });
    expect(r.itemTotal).toBe(500_000);
    expect(r.voucherAmount).toBe(0);
    expect(r.amount).toBe(500_000);
  });

  it('AMOUNT voucher subtracts flat IDR', () => {
    const r = computeTotals({
      unitPrice: 500_000,
      voucher: { type: 'AMOUNT', value: 50_000 },
    });
    expect(r.voucherAmount).toBe(50_000);
    expect(r.amount).toBe(450_000);
  });

  it('PERCENT voucher floors', () => {
    const r = computeTotals({
      unitPrice: 99_999,
      voucher: { type: 'PERCENT', value: 10 },
    });
    expect(r.voucherAmount).toBe(9_999);
    expect(r.amount).toBe(90_000);
  });

  it('PERCENT voucher caps at maxAmount', () => {
    const r = computeTotals({
      unitPrice: 1_000_000,
      voucher: { type: 'PERCENT', value: 50, maxAmount: 100_000 },
    });
    expect(r.voucherAmount).toBe(100_000);
    expect(r.amount).toBe(900_000);
  });

  it('voucher > itemTotal clamps to itemTotal (amount=0)', () => {
    const r = computeTotals({
      unitPrice: 50_000,
      voucher: { type: 'AMOUNT', value: 100_000 },
    });
    expect(r.voucherAmount).toBe(50_000);
    expect(r.amount).toBe(0);
  });

  it('PERCENT 100% gives full discount (voucher-bypass path)', () => {
    const r = computeTotals({
      unitPrice: 500_000,
      voucher: { type: 'PERCENT', value: 100 },
    });
    expect(r.voucherAmount).toBe(500_000);
    expect(r.amount).toBe(0);
  });

  it('qty>1 multiplies itemTotal', () => {
    const r = computeTotals({ unitPrice: 100_000, qty: 3 });
    expect(r.itemTotal).toBe(300_000);
    expect(r.amount).toBe(300_000);
  });

  it('qty<1 normalized to 1', () => {
    const r = computeTotals({ unitPrice: 100_000, qty: 0 });
    expect(r.itemTotal).toBe(100_000);
  });

  it('negative voucher value clamped to 0', () => {
    const r = computeTotals({
      unitPrice: 100_000,
      voucher: { type: 'AMOUNT', value: -5000 },
    });
    expect(r.voucherAmount).toBe(0);
    expect(r.amount).toBe(100_000);
  });
});
