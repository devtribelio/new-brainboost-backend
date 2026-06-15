import { describe, it, expect } from 'vitest';
import { cutChainCycles } from '@bb/domain/affiliate/utils/walk-inviter-chain';

// Regression for the self-referral / circular-inviter payout abuse: a mutual
// A<->B inviter link makes the recursive CTE emit the same member at multiple
// levels. cutChainCycles must stop at the first repeat so no member is paid twice.
describe('cutChainCycles', () => {
  it('returns a normal chain unchanged', () => {
    const rows = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
    expect(cutChainCycles(rows)).toEqual(rows);
  });

  it('cuts a 2-cycle (A→B→A→B) at the first repeat', () => {
    const rows = [{ id: 'A' }, { id: 'B' }, { id: 'A' }, { id: 'B' }];
    expect(cutChainCycles(rows).map((r) => r.id)).toEqual(['A', 'B']);
  });

  it('cuts a self-loop (A→A) immediately', () => {
    const rows = [{ id: 'A' }, { id: 'A' }];
    expect(cutChainCycles(rows).map((r) => r.id)).toEqual(['A']);
  });

  it('handles an empty chain', () => {
    expect(cutChainCycles([])).toEqual([]);
  });

  it('preserves the first occurrence ordering before the cut', () => {
    const rows = [{ id: 'B' }, { id: 'A' }, { id: 'C' }, { id: 'A' }];
    expect(cutChainCycles(rows).map((r) => r.id)).toEqual(['B', 'A', 'C']);
  });
});
