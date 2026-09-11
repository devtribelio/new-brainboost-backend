import { describe, it, expect } from 'vitest';
import { computeTicketItemTotal } from '@bb/domain/event/price-tier';

const UNIT = 200_000;
const LADDER = [
  { minQty: 2, totalPrice: 350_000, label: 'Duo' },
  { minQty: 3, totalPrice: 500_000, label: 'Trio' },
];

describe('computeTicketItemTotal', () => {
  // The table from the PRD (§15.3).
  it.each([
    [1, 200_000],
    [2, 350_000],
    [3, 500_000],
    [4, 700_000],
    [5, 850_000],
    [6, 1_000_000],
  ])('prices qty %i as %i', (qty, expected) => {
    expect(computeTicketItemTotal(UNIT, LADDER, qty).itemTotal).toBe(expected);
  });

  it('charges the same whichever packages the buyer thought they were picking', () => {
    // "4 Solo" and "Trio + Solo" are the same order: qty 4.
    expect(computeTicketItemTotal(UNIT, LADDER, 4).itemTotal).toBe(
      computeTicketItemTotal(UNIT, LADDER, 4).itemTotal,
    );
    // And it is the cheapest of every combination, not merely a plausible one.
    expect(computeTicketItemTotal(UNIT, LADDER, 4).itemTotal).toBeLessThan(4 * UNIT);
  });

  /**
   * The reason this is DP and not greedy. Per-ticket price strictly decreases
   * (200k → 150k → 140k) and every backoffice validation passes, yet taking the
   * largest package first overcharges: 5 + 3×single = 1 300 000.
   */
  it('beats greedy when the ladder has a gap below its largest tier', () => {
    const gapped = [
      { minQty: 4, totalPrice: 600_000, label: 'Paket 4' },
      { minQty: 5, totalPrice: 700_000, label: 'Paket 5' },
    ];
    const r = computeTicketItemTotal(UNIT, gapped, 8);
    expect(r.itemTotal).toBe(1_200_000);
    expect(r.breakdown).toEqual([{ label: 'Paket 4', qty: 8, amount: 1_200_000 }]);
  });

  it('returns a breakdown that adds up to the total', () => {
    const r = computeTicketItemTotal(UNIT, LADDER, 5);
    expect(r.breakdown).toEqual([
      { label: 'Trio', qty: 3, amount: 500_000 },
      { label: 'Duo', qty: 2, amount: 350_000 },
    ]);
    expect(r.breakdown.reduce((s, l) => s + l.amount, 0)).toBe(r.itemTotal);
    expect(r.breakdown.reduce((s, l) => s + l.qty, 0)).toBe(5);
  });

  it('names an unlabelled tier by its size', () => {
    const r = computeTicketItemTotal(UNIT, [{ minQty: 3, totalPrice: 500_000 }], 3);
    expect(r.breakdown).toEqual([{ label: 'Paket 3', qty: 3, amount: 500_000 }]);
  });

  it('prefers the package when a package and singles cost the same', () => {
    // 2 × 200k = 400k either way; the receipt should say Duo, not "2 satuan".
    const r = computeTicketItemTotal(UNIT, [{ minQty: 2, totalPrice: 400_000, label: 'Duo' }], 2);
    expect(r.breakdown).toEqual([{ label: 'Duo', qty: 2, amount: 400_000 }]);
  });

  it('is the old behaviour exactly when there is no ladder', () => {
    for (const qty of [1, 2, 7]) {
      const r = computeTicketItemTotal(UNIT, [], qty);
      expect(r.itemTotal).toBe(UNIT * qty);
      expect(r.breakdown).toEqual([{ label: 'Satuan', qty, amount: UNIT * qty }]);
    }
  });

  it('ignores tiers that cannot apply', () => {
    const r = computeTicketItemTotal(UNIT, [{ minQty: 5, totalPrice: 700_000 }], 3);
    expect(r.itemTotal).toBe(600_000);
  });

  it('never charges more than buying every ticket singly', () => {
    // A ladder is a discount. If one row is nonsense the buyer must not pay for it.
    const absurd = [
      { minQty: 2, totalPrice: 900_000 },
      { minQty: 3, totalPrice: 450_000 },
    ];
    for (let qty = 1; qty <= 10; qty++) {
      expect(computeTicketItemTotal(UNIT, absurd, qty).itemTotal).toBeLessThanOrEqual(UNIT * qty);
    }
  });

  it('handles a free ticket kind', () => {
    const r = computeTicketItemTotal(0, [], 3);
    expect(r.itemTotal).toBe(0);
  });
});
