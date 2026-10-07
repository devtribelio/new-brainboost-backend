import { describe, expect, it } from 'vitest';
import { INVITER_CORRECTIONS, planInviterCorrection } from '../src/inviter-correction-rules';

const base = {
  currentInviterId: 'old',
  currentSource: 'LEGACY_PARENT',
  subjectId: 'subj',
  proposedInviterId: 'new',
  proposedClosesCycle: false,
  allowAppOwned: false,
};

describe('planInviterCorrection', () => {
  it('applies a legacy-parent correction with provenance LEGACY_PARENT', () => {
    expect(planInviterCorrection(base)).toEqual({
      patch: { inviterId: 'new', inviterSource: 'LEGACY_PARENT' },
      outcome: 'applied',
    });
  });

  it('clears an inviter (null + null source)', () => {
    expect(planInviterCorrection({ ...base, proposedInviterId: null })).toEqual({
      patch: { inviterId: null, inviterSource: null },
      outcome: 'applied',
    });
  });

  it('never touches an app-owned inviter unless the correction opts in', () => {
    expect(planInviterCorrection({ ...base, currentSource: 'APP' })).toEqual({
      patch: null,
      outcome: 'app-owned',
    });
    expect(planInviterCorrection({ ...base, currentSource: 'APP', allowAppOwned: true }).outcome).toBe('applied');
  });

  it('rejects a self-inviter and a cycle', () => {
    expect(planInviterCorrection({ ...base, proposedInviterId: 'subj' }).outcome).toBe('self');
    expect(planInviterCorrection({ ...base, proposedClosesCycle: true }).outcome).toBe('cycle');
  });

  it('is a no-op when the value already matches', () => {
    expect(
      planInviterCorrection({
        ...base,
        currentInviterId: 'new',
        currentSource: 'LEGACY_PARENT',
      }),
    ).toEqual({ patch: null, outcome: 'already-ok' });
  });

  it('whitelists the four audit corrections and opts 390754 over an app-owned link', () => {
    expect(INVITER_CORRECTIONS.map((c) => c.legacyId)).toEqual([424829, 409824, 641123, 390754]);
    expect(INVITER_CORRECTIONS.find((c) => c.legacyId === 390754)?.allowAppOwned).toBe(true);
    expect(INVITER_CORRECTIONS.find((c) => c.legacyId === 424829)?.newInviterLegacyId).toBe(57);
  });
});
