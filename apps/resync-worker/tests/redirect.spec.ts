import { describe, expect, it } from 'vitest';
import { flattenRedirects } from '../src/util';

/** `member_redirect` is normally one hop, but manual seeds / split-merge can chain. */
const raw = (entries: Array<[number, number]>) => new Map(entries);

const terminalOf = (flat: Map<number, number>, id: number): number => flat.get(id) ?? id;

describe('flattenRedirects', () => {
  it('keeps a single hop', () => {
    expect([...flattenRedirects(raw([[10, 20]]))]).toEqual([[10, 20]]);
  });

  it('follows a chain A→B→C to its terminal', () => {
    const flat = flattenRedirects(raw([[1, 2], [2, 3]]));
    expect(flat.get(1)).toBe(3);
    expect(flat.get(2)).toBe(3);
    expect(flat.has(3)).toBe(false); // a winner (no outgoing edge) is not a loser
  });

  it('points every loser on a branch at the same terminal', () => {
    const flat = flattenRedirects(raw([[1, 3], [2, 3], [3, 4]]));
    expect([...flat.entries()].sort((a, b) => a[0] - b[0])).toEqual([[1, 4], [2, 4], [3, 4]]);
  });

  it('drops self-pointing entries', () => {
    expect(flattenRedirects(raw([[7, 7]])).size).toBe(0);
  });

  it('folds a cycle onto one node and never leaves a cycle behind', () => {
    const flat = flattenRedirects(raw([[1, 2], [2, 1]]));
    expect(terminalOf(flat, 1)).toBe(terminalOf(flat, 2)); // both resolve to the same member
    for (const [loser, winner] of flat) expect(winner).not.toBe(loser);
  });

  it('lets a loser resolve through the chain to the terminal winner member', () => {
    const memberByLegacy = new Map<number, string>([[3, 'uuid-c']]);
    const flat = flattenRedirects(raw([[1, 2], [2, 3]]));
    const resolveMember = (id: number) => memberByLegacy.get(flat.get(id) ?? id);
    expect(resolveMember(1)).toBe('uuid-c');
    expect(resolveMember(2)).toBe('uuid-c');
    expect(resolveMember(3)).toBe('uuid-c');
  });
});
