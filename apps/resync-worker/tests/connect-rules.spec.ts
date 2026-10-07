import { describe, expect, it } from 'vitest';
import { decideConnectWrite, type ConnectInput, type ConnectVariant } from '../src/syncers/connect-rules';

const S = 'subject';
const CONNECT = 'conn';
const PARENT = 'parent';

function input(over: Partial<ConnectInput> = {}): ConnectInput {
  return {
    subjectId: S,
    current: { inviterId: PARENT, inviterSource: 'LEGACY_PARENT' },
    connectActive: true,
    affiliatorId: CONNECT,
    parentId: PARENT,
    hasDownlines: false,
    connectClosesCycle: false,
    parentClosesCycle: false,
    ...over,
  };
}

const toConnect = { inviterId: CONNECT, inviterSource: 'LEGACY_CONNECT' };
const toParent = { inviterId: PARENT, inviterSource: 'LEGACY_PARENT' };

describe('decideConnectWrite — rules shared by both variants', () => {
  const both: ConnectVariant[] = ['A', 'C'];

  it.each(both)('%s: active connect, no downlines → connect wins over the legacy parent', (v) => {
    expect(decideConnectWrite(input(), v)).toEqual({ patch: toConnect });
  });

  it.each(both)('%s: active connect over a NULL inviter', (v) => {
    const r = decideConnectWrite(input({ current: { inviterId: null, inviterSource: null }, parentId: null }), v);
    expect(r).toEqual({ patch: toConnect });
  });

  it.each(both)('%s: connect equal to the parent still stamps LEGACY_CONNECT (even with downlines)', (v) => {
    const r = decideConnectWrite(input({ affiliatorId: PARENT, hasDownlines: true }), v);
    expect(r).toEqual({ patch: { inviterId: PARENT, inviterSource: 'LEGACY_CONNECT' } });
  });

  it.each(both)('%s: already applied → no write', (v) => {
    const r = decideConnectWrite(input({ current: { inviterId: CONNECT, inviterSource: 'LEGACY_CONNECT' } }), v);
    expect(r).toEqual({ patch: null });
  });

  it.each(both)('%s: never overwrites an APP inviter (active or removed)', (v) => {
    const current = { inviterId: 'X', inviterSource: 'APP' };
    expect(decideConnectWrite(input({ current }), v)).toEqual({ patch: null });
    expect(decideConnectWrite(input({ current, connectActive: false }), v)).toEqual({ patch: null });
  });

  it.each(both)('%s: never touches an unknown inviter_source', (v) => {
    expect(decideConnectWrite(input({ current: { inviterId: 'X', inviterSource: 'SOMETHING' } }), v)).toEqual({ patch: null });
  });

  it.each(both)('%s: self-connect is ignored (parent stays)', (v) => {
    expect(decideConnectWrite(input({ affiliatorId: S }), v)).toEqual({ patch: null, reason: 'self-connect' });
  });

  it.each(both)('%s: self-connect over a previously applied connect → reverts to the parent', (v) => {
    const r = decideConnectWrite(input({ affiliatorId: S, current: { inviterId: 'OLD', inviterSource: 'LEGACY_CONNECT' } }), v);
    expect(r).toEqual({ patch: toParent, reason: 'reverted' });
  });

  it.each(both)('%s: affiliator not resolvable → no write', (v) => {
    expect(decideConnectWrite(input({ affiliatorId: undefined }), v)).toEqual({ patch: null, reason: 'unresolved' });
  });

  it.each(both)('%s: connect that would close a cycle is rejected', (v) => {
    expect(decideConnectWrite(input({ connectClosesCycle: true }), v)).toEqual({ patch: null, reason: 'cycle' });
  });

  describe('removed connect (status=0)', () => {
    const applied = { inviterId: CONNECT, inviterSource: 'LEGACY_CONNECT' };

    it.each(both)('%s: reverts a LEGACY_CONNECT inviter to the legacy parent', (v) => {
      const r = decideConnectWrite(input({ connectActive: false, current: applied }), v);
      expect(r).toEqual({ patch: toParent, reason: 'reverted' });
    });

    it.each(both)('%s: no parent + inviter is the removed connect → cleared', (v) => {
      const r = decideConnectWrite(input({ connectActive: false, current: applied, parentId: null }), v);
      expect(r).toEqual({ patch: { inviterId: null, inviterSource: null }, reason: 'revert-cleared' });
    });

    it.each(both)('%s: parent would close a cycle → treated as no parent (cleared)', (v) => {
      const r = decideConnectWrite(input({ connectActive: false, current: applied, parentClosesCycle: true }), v);
      expect(r).toEqual({ patch: { inviterId: null, inviterSource: null }, reason: 'revert-cleared' });
    });

    it.each(both)('%s: no parent + inviter is NOT the removed connect → left as is', (v) => {
      const r = decideConnectWrite(
        input({ connectActive: false, current: { inviterId: 'OTHER', inviterSource: 'LEGACY_CONNECT' }, parentId: null }),
        v,
      );
      expect(r).toEqual({ patch: null, reason: 'revert-kept' });
    });

    it.each(both)('%s: inviter not set by connect → nothing to undo', (v) => {
      expect(decideConnectWrite(input({ connectActive: false }), v)).toEqual({ patch: null });
      const none = { inviterId: null, inviterSource: null };
      expect(decideConnectWrite(input({ connectActive: false, current: none }), v)).toEqual({ patch: null });
    });
  });
});

describe('decideConnectWrite — the variant choice (connect ≠ parent AND member has downlines)', () => {
  it('A: connect wins anyway', () => {
    expect(decideConnectWrite(input({ hasDownlines: true }), 'A')).toEqual({ patch: toConnect });
  });

  it('C: keeps the parent and flags for review', () => {
    expect(decideConnectWrite(input({ hasDownlines: true }), 'C')).toEqual({ patch: null, reason: 'downlines' });
  });

  it('C: no legacy parent at all still counts as connect ≠ parent', () => {
    const r = decideConnectWrite(
      input({ hasDownlines: true, parentId: null, current: { inviterId: null, inviterSource: null } }),
      'C',
    );
    expect(r).toEqual({ patch: null, reason: 'downlines' });
  });

  it('C: already flipped to the connect, gained downlines later → never flips back', () => {
    const r = decideConnectWrite(
      input({ hasDownlines: true, current: { inviterId: CONNECT, inviterSource: 'LEGACY_CONNECT' } }),
      'C',
    );
    expect(r).toEqual({ patch: null });
  });

  it('C: flipped to a different connect earlier, gained downlines → keeps it, logs', () => {
    const r = decideConnectWrite(
      input({ hasDownlines: true, current: { inviterId: 'OLD', inviterSource: 'LEGACY_CONNECT' } }),
      'C',
    );
    expect(r).toEqual({ patch: null, reason: 'downlines-later' });
  });

  it('C: without downlines behaves like A', () => {
    expect(decideConnectWrite(input(), 'C')).toEqual(decideConnectWrite(input(), 'A'));
  });

  it('A: a removed connect reverts the same way as C', () => {
    const removed = input({ connectActive: false, hasDownlines: true, current: { inviterId: CONNECT, inviterSource: 'LEGACY_CONNECT' } });
    expect(decideConnectWrite(removed, 'A')).toEqual(decideConnectWrite(removed, 'C'));
  });
});
