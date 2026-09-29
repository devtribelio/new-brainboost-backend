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

  it('TRIAL discounts 100% regardless of value (never falls through to the AMOUNT branch)', () => {
    // The trap: TRIAL rows carry value=0, so an unhandled type would land in the
    // AMOUNT branch, discount nothing and charge the member full price for what
    // was advertised as a free trial.
    const r = computeTotals({ unitPrice: 500_000, voucher: { type: 'TRIAL', value: 0 } });
    expect(r.itemTotal).toBe(500_000);
    expect(r.voucherAmount).toBe(500_000);
    expect(r.amount).toBe(0);
  });

  describe('tax (PPN)', () => {
    it('no taxRate = the pre-tax function, byte for byte', () => {
      const r = computeTotals({ unitPrice: 500_000, voucher: { type: 'AMOUNT', value: 50_000 } });
      expect(r).toEqual({ itemTotal: 500_000, voucherAmount: 50_000, taxRate: 0, taxAmount: 0, amount: 450_000 });
    });

    it('T-01 no voucher: tax on the full price, amount tax-inclusive', () => {
      const r = computeTotals({ unitPrice: 500_000, taxRate: 11 });
      expect(r.taxRate).toBe(11);
      expect(r.taxAmount).toBe(55_000);
      expect(r.amount).toBe(555_000);
    });

    it('T-02 voucher first, then tax on what is left', () => {
      const r = computeTotals({ unitPrice: 1_000_000, voucher: { type: 'PERCENT', value: 50 }, taxRate: 11 });
      expect(r.voucherAmount).toBe(500_000); // still on the PRE-tax price
      expect(r.taxAmount).toBe(55_000);
      expect(r.amount).toBe(555_000);
    });

    it('T-03 100% voucher leaves nothing to tax — still settles at 0 (voucher bypass)', () => {
      const r = computeTotals({ unitPrice: 50_000, voucher: { type: 'AMOUNT', value: 100_000 }, taxRate: 11 });
      expect(r.taxAmount).toBe(0);
      expect(r.amount).toBe(0);
    });

    it('T-04 TRIAL is untaxed for the same reason', () => {
      const r = computeTotals({ unitPrice: 500_000, voucher: { type: 'TRIAL', value: 0 }, taxRate: 11 });
      expect(r.taxAmount).toBe(0);
      expect(r.amount).toBe(0);
    });

    it('T-07 taxes a supplied itemTotal (event ladder), not unitPrice x qty', () => {
      const r = computeTotals({ unitPrice: 200_000, qty: 5, itemTotal: 850_000, taxRate: 11 });
      expect(r.itemTotal).toBe(850_000);
      expect(r.taxAmount).toBe(93_500);
      expect(r.amount).toBe(943_500);
    });

    it('rounds half up to a whole rupiah', () => {
      // 4_545 × 11% = 499.95 → 500; 50 × 11% = 5.5 → 6 (not banker's 6/5 ambiguity, not floor 5).
      expect(computeTotals({ unitPrice: 4_545, taxRate: 11 }).taxAmount).toBe(500);
      expect(computeTotals({ unitPrice: 50, taxRate: 11 }).taxAmount).toBe(6);
      expect(computeTotals({ unitPrice: 40, taxRate: 11 }).taxAmount).toBe(4); // 4.4 → 4
    });

    it('a negative or zero rate means no tax', () => {
      expect(computeTotals({ unitPrice: 100_000, taxRate: 0 }).taxAmount).toBe(0);
      expect(computeTotals({ unitPrice: 100_000, taxRate: -5 }).taxRate).toBe(0);
    });
  });
});
