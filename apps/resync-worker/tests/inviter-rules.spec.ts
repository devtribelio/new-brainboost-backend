import { describe, expect, it } from 'vitest';
import {
  CYCLE_CHECK_LEVELS,
  MAX_CLIMB_HOPS,
  chainHitsSubject,
  mayOverwriteInviter,
  pickInviter,
  planInviterWrite,
} from '../src/syncers/inviter-rules';

const S = 'subject';

describe('pickInviter', () => {
  it.each([
    { name: 'direct parent is another member', ancestors: ['P'], want: { status: 'ok', inviterId: 'P', hops: 0 } },
    {
      name: 'parent is an alias of the subject → climbs to the alias node parent',
      ancestors: [S, 'P57'],
      want: { status: 'ok', inviterId: 'P57', hops: 1 },
    },
    { name: 'several self ancestors in a row are skipped', ancestors: [S, S, 'P'], want: { status: 'ok', inviterId: 'P', hops: 2 } },
    { name: 'still self after the climb runs out', ancestors: [S, S], want: { status: 'self' } },
    { name: 'direct parent not materialised', ancestors: [undefined], want: { status: 'unresolved' } },
    { name: 'alias parent whose own parent is not materialised', ancestors: [S, undefined], want: { status: 'unresolved' } },
    { name: 'no ancestors at all', ancestors: [], want: { status: 'self' } },
  ])('$name', ({ ancestors, want }) => {
    expect(pickInviter(S, ancestors)).toEqual(want);
  });

  it(`climbs at most ${MAX_CLIMB_HOPS} hops past the direct parent`, () => {
    const withinBound = [...Array(MAX_CLIMB_HOPS).fill(S), 'P'];
    expect(pickInviter(S, withinBound)).toEqual({ status: 'ok', inviterId: 'P', hops: MAX_CLIMB_HOPS });
    const pastBound = [...Array(MAX_CLIMB_HOPS + 1).fill(S), 'P'];
    expect(pickInviter(S, pastBound)).toEqual({ status: 'self' });
  });
});

describe('chainHitsSubject', () => {
  it.each([
    { name: 'mutual pair (candidate already invited by subject)', chain: [S], want: true },
    { name: 'cycle at level 4', chain: ['C', 'D', 'E', S], want: true },
    { name: 'subject beyond the checked depth', chain: ['C', 'D', 'E', 'F', S], want: false },
    { name: 'clean chain', chain: ['C', 'D', null], want: false },
    { name: 'candidate has no inviter', chain: [null], want: false },
    { name: 'empty chain', chain: [], want: false },
  ])('$name → $want', ({ chain, want }) => {
    expect(chainHitsSubject(S, chain)).toBe(want);
  });

  it('checks exactly CYCLE_CHECK_LEVELS levels', () => {
    expect(CYCLE_CHECK_LEVELS).toBe(4);
  });
});

describe('mayOverwriteInviter', () => {
  it.each([
    { source: null, want: true },
    { source: 'LEGACY_PARENT', want: true },
    { source: 'APP', want: false },
    { source: 'LEGACY_CONNECT', want: false },
  ])('source $source → $want', ({ source, want }) => {
    expect(mayOverwriteInviter(source)).toBe(want);
  });
});

describe('planInviterWrite', () => {
  const ok = (inviterId: string, hops = 0) => ({ status: 'ok', inviterId, hops }) as const;

  it('writes a normal legacy parent with source LEGACY_PARENT', () => {
    const r = planInviterWrite({ subjectId: S, current: { inviterId: null, inviterSource: null }, pick: ok('P'), createsCycle: false });
    expect(r).toEqual({ patch: { inviterId: 'P', inviterSource: 'LEGACY_PARENT' } });
  });

  it('replaces a previous LEGACY_PARENT inviter', () => {
    const r = planInviterWrite({
      subjectId: S,
      current: { inviterId: 'OLD', inviterSource: 'LEGACY_PARENT' },
      pick: ok('P'),
      createsCycle: false,
    });
    expect(r.patch).toEqual({ inviterId: 'P', inviterSource: 'LEGACY_PARENT' });
  });

  it('writes the climbed parent and reports the climb', () => {
    const r = planInviterWrite({ subjectId: S, current: { inviterId: S, inviterSource: null }, pick: ok('P57', 1), createsCycle: false });
    expect(r).toEqual({ patch: { inviterId: 'P57', inviterSource: 'LEGACY_PARENT' }, reason: 'climbed' });
  });

  it.each(['APP', 'LEGACY_CONNECT'])('never overwrites a %s inviter', (source) => {
    const r = planInviterWrite({ subjectId: S, current: { inviterId: 'X', inviterSource: source }, pick: ok('P'), createsCycle: false });
    expect(r.patch).toBeNull();
  });

  it('never writes NULL over a non-null inviter when legacy has no parent', () => {
    const r = planInviterWrite({ subjectId: S, current: { inviterId: 'X', inviterSource: 'LEGACY_PARENT' }, pick: null, createsCycle: false });
    expect(r.patch).toBeNull();
  });

  it('leaves the inviter alone when the legacy parent is unresolved', () => {
    const r = planInviterWrite({
      subjectId: S,
      current: { inviterId: 'X', inviterSource: 'LEGACY_PARENT' },
      pick: { status: 'unresolved' },
      createsCycle: false,
    });
    expect(r.patch).toBeNull();
  });

  it('still self after the climb → clears a self inviter and warns', () => {
    const r = planInviterWrite({ subjectId: S, current: { inviterId: S, inviterSource: 'LEGACY_PARENT' }, pick: { status: 'self' }, createsCycle: false });
    expect(r).toEqual({ patch: { inviterId: null, inviterSource: null }, reason: 'self' });
  });

  it('still self after the climb → keeps a non-self inviter and warns', () => {
    const r = planInviterWrite({ subjectId: S, current: { inviterId: 'X', inviterSource: 'LEGACY_PARENT' }, pick: { status: 'self' }, createsCycle: false });
    expect(r).toEqual({ patch: null, reason: 'self' });
  });

  it('rejects a candidate that would close a cycle', () => {
    const r = planInviterWrite({ subjectId: S, current: { inviterId: null, inviterSource: null }, pick: ok('B'), createsCycle: true });
    expect(r).toEqual({ patch: null, reason: 'cycle' });
  });

  it('rejected cycle still clears a self inviter', () => {
    const r = planInviterWrite({ subjectId: S, current: { inviterId: S, inviterSource: null }, pick: ok('B'), createsCycle: true });
    expect(r).toEqual({ patch: { inviterId: null, inviterSource: null }, reason: 'cycle' });
  });

  it('no legacy parent but the stored inviter is self → clears it', () => {
    const r = planInviterWrite({ subjectId: S, current: { inviterId: S, inviterSource: null }, pick: null, createsCycle: false });
    expect(r.patch).toEqual({ inviterId: null, inviterSource: null });
  });
});
