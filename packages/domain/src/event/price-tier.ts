/**
 * Bundle pricing for event tickets: a package is presentation, the quantity is
 * the reality. "Trio + 1 Solo" is qty 4 of one ticket kind, priced here.
 */

export interface PriceTier {
  minQty: number;
  totalPrice: number;
  label?: string | null;
}

export interface PriceLine {
  /** What to show: a tier's label, its fallback, or the single-ticket line. */
  label: string;
  qty: number;
  amount: number;
}

export interface TicketItemTotal {
  itemTotal: number;
  breakdown: PriceLine[];
}

/** Shown when a tier carries no label of its own. */
function tierLabel(tier: PriceTier): string {
  return tier.label?.trim() || `Paket ${tier.minQty}`;
}

/**
 * Cheapest total for `qty` tickets, plus the combination that produced it.
 *
 * **Exhaustive, not greedy.** Taking the largest package first is wrong, and the
 * monotonicity rule does not save it: with a unit of 200k and tiers {4 → 600k,
 * 5 → 700k} — per-ticket price strictly decreasing, every validation satisfied —
 * greedy prices 8 tickets as 5 + 3 singles = 1 300 000, while 4 + 4 = 1 200 000.
 * Greedy fails whenever there is a GAP below the largest tier, which is exactly
 * how a real ladder looks when ops offers "package of 4" and "package of 5" and
 * nothing smaller. Since the promise to the buyer is the cheapest combination,
 * the algorithm has to actually find it.
 *
 * So: min-cost dynamic programming over 1..qty. `qty` is bounded by the
 * attendee cap (50) and a ladder has a handful of rows, so this is arithmetic,
 * not a cost worth optimising.
 *
 * A consequence worth knowing: monotonicity stops being load-bearing. The
 * backoffice still rejects an absurd ladder, but if one slips through, the buyer
 * is charged the cheapest combination regardless — the bad tier simply never
 * gets used.
 */
export function computeTicketItemTotal(
  unitPrice: number,
  tiers: PriceTier[],
  qty: number,
): TicketItemTotal {
  const n = Math.max(1, Math.floor(qty));
  // Ascending, and the comparison below is `<=`, so on a TIE the last candidate
  // considered wins: a package beats an equal pile of singles, and a bigger
  // package beats a smaller one. Same price either way — it is the receipt that
  // improves ("Duo", not "2 satuan").
  const usable = tiers
    .filter((t) => Number.isInteger(t.minQty) && t.minQty >= 2 && t.minQty <= n && t.totalPrice >= 0)
    .sort((a, b) => a.minQty - b.minQty);

  if (usable.length === 0) {
    const itemTotal = unitPrice * n;
    return { itemTotal, breakdown: [{ label: 'Satuan', qty: n, amount: itemTotal }] };
  }

  const best: number[] = [0];
  /** Which tier closed the gap at this qty; null = one more single ticket. */
  const via: (PriceTier | null)[] = [null];

  for (let q = 1; q <= n; q++) {
    best[q] = best[q - 1] + unitPrice;
    via[q] = null;
    for (const tier of usable) {
      if (tier.minQty > q) continue;
      const candidate = best[q - tier.minQty] + tier.totalPrice;
      if (candidate <= best[q]) {
        best[q] = candidate;
        via[q] = tier;
      }
    }
  }

  // Walk back, collapsing repeats of the same tier and all singles into one line.
  const tierCounts = new Map<PriceTier, number>();
  let singles = 0;
  for (let q = n; q > 0; ) {
    const tier = via[q];
    if (!tier) {
      singles += 1;
      q -= 1;
      continue;
    }
    tierCounts.set(tier, (tierCounts.get(tier) ?? 0) + 1);
    q -= tier.minQty;
  }

  // Biggest package first on the receipt, which is how a buyer reads it.
  const breakdown: PriceLine[] = [];
  for (const tier of [...usable].reverse()) {
    const count = tierCounts.get(tier);
    if (count) {
      breakdown.push({
        label: tierLabel(tier),
        qty: tier.minQty * count,
        amount: tier.totalPrice * count,
      });
    }
  }
  if (singles > 0) {
    breakdown.push({ label: 'Satuan', qty: singles, amount: unitPrice * singles });
  }

  return { itemTotal: best[n], breakdown };
}
