import { describe, expect, it } from 'vitest';
import {
  decideAffiliatorWrite,
  isLegacyAffiliatorActive,
  prefersAffiliatorRow,
  type ExistingAffiliator,
} from '../src/syncers/affiliator-rules';

const STAMP = new Date('2026-09-01T00:00:00Z');
const live = { status: 1, exitState: null, deleted: null, deleteAt: null };

describe('isLegacyAffiliatorActive', () => {
  it.each([
    ['live row', live, true],
    ['kicked (status 0 + KICK + exit/delete stamps)', { status: 0, exitState: 'KICK', deleted: null, deleteAt: STAMP }, false],
    ['status 0 only', { ...live, status: 0 }, false],
    ['status as string "1"', { ...live, status: '1' }, true],
    ['status null', { ...live, status: null }, false],
    ['exit_state set with status 1', { ...live, exitState: 'LEAVE' }, false],
    ['deleted DATETIME set', { ...live, deleted: STAMP }, false],
    ['delete_at set', { ...live, deleteAt: STAMP }, false],
    ['empty exit_state is not an exit', { ...live, exitState: '' }, true],
    ['zero-date deleted (Invalid Date) is not a delete', { ...live, deleted: new Date('0000-00-00') }, true],
  ] as const)('%s', (_name, row, expected) => {
    expect(isLegacyAffiliatorActive(row)).toBe(expected);
  });
});

describe('decideAffiliatorWrite', () => {
  const row = (o: Partial<ExistingAffiliator>): ExistingAffiliator => ({ legacyId: 100, isActive: true, ...o });

  it.each([
    ['no row for the pair → create', undefined, 100, true, 'create'],
    ['same legacy row, now kicked → refresh', row({}), 100, false, 'refresh'],
    ['same legacy row → refresh', row({ isActive: false }), 100, true, 'refresh'],
    ['new-system row → skip', row({ legacyId: null }), 200, true, 'skip'],
    ['re-join after kick (held row dead) → repoint', row({ isActive: false }), 200, true, 'repoint'],
    ['newer live row while held still looks live → repoint', row({}), 200, true, 'repoint'],
    ['older live row while held is live → skip', row({ legacyId: 300 }), 200, true, 'skip'],
    ['older live row while held is dead → repoint', row({ legacyId: 300, isActive: false }), 200, true, 'repoint'],
    ['incoming dead, held dead → skip', row({ isActive: false }), 200, false, 'skip'],
    ['incoming dead, held live → skip', row({}), 200, false, 'skip'],
  ] as const)('%s', (_name, existing, legacyId, isActive, expected) => {
    expect(decideAffiliatorWrite(existing, { legacyId, isActive })).toBe(expected);
  });
});

describe('prefersAffiliatorRow', () => {
  it.each([
    ['live over dead even when older', { legacyId: 1, isActive: true }, { legacyId: 2, isActive: false }, true],
    ['dead never over live', { legacyId: 2, isActive: false }, { legacyId: 1, isActive: true }, false],
    ['both live → newer wins', { legacyId: 2, isActive: true }, { legacyId: 1, isActive: true }, true],
    ['both dead → newer wins', { legacyId: 1, isActive: false }, { legacyId: 2, isActive: false }, false],
  ] as const)('%s', (_name, a, b, expected) => {
    expect(prefersAffiliatorRow(a, b)).toBe(expected);
  });
});
