/**
 * One-off inviter corrections for the redirect-collapse cases found by the audit (PRD §5 /
 * audit 03). The tree syncer's self/cycle guard already prevents NEW bad writes, but these
 * rows are behind the watermark (and two of them cannot be fixed by a rescan at all):
 *   - 424829 / 409824 are self-inviters via a redirect to one of their own loser accounts.
 *     A forced `resync tree --since=1970` fixes these through the guard.
 *   - 641123 is one half of a MUTUAL cycle (641626 <-> 641123). The guard refuses to write a
 *     cycle, so the mutual pair is left as is and must be cut by hand.
 *   - 390754's inviter was set by the app (a "Juna (DEV)" test account), so the tree will
 *     never overwrite it (inviter_source='APP'). It needs a deliberate override.
 */
import { INVITER_SOURCE } from './syncers/inviter-rules';

export interface InviterCorrection {
  /** subject legacy member id ('the member whose inviter_id is wrong'). */
  legacyId: number;
  /** legacy id of the correct inviter, or null to clear. */
  newInviterLegacyId: number | null;
  note: string;
  /** write even over inviter_source='APP' (a wrong/test app link) — deliberate override. */
  allowAppOwned?: boolean;
}

export const INVITER_CORRECTIONS: readonly InviterCorrection[] = [
  {
    legacyId: 424829,
    newInviterLegacyId: 57,
    note: 'self-inviter via loser alias 395307; real upline is 57 (Denny Santoso)',
  },
  {
    legacyId: 409824,
    newInviterLegacyId: null,
    note: 'self-inviter via loser 223331 (loser has no parent) — clear',
  },
  {
    legacyId: 641123,
    newInviterLegacyId: null,
    note: 'mutual cycle 641626 <-> 641123 — the guard refuses cycles, so cut it by hand',
  },
  {
    legacyId: 390754,
    newInviterLegacyId: 57,
    note: 'wrongly linked to app test account "Juna (DEV)"; legacy parent is 57',
    allowAppOwned: true,
  },
];

export type CorrectionOutcome =
  | 'applied'
  | 'already-ok'
  | 'app-owned'
  | 'self'
  | 'cycle'
  | 'subject-missing'
  | 'inviter-missing';

export interface CorrectionPlan {
  patch: { inviterId: string | null; inviterSource: string | null } | null;
  outcome: CorrectionOutcome;
}

/**
 * Decide the write for one correction. Never writes a self-inviter or a cycle, and never
 * touches an app-owned inviter unless the correction explicitly opts in.
 */
export function planInviterCorrection(input: {
  currentInviterId: string | null;
  currentSource: string | null;
  subjectId: string;
  /** resolved PG uuid of the proposed inviter, or null to clear. */
  proposedInviterId: string | null;
  /** proposed inviter's 4-level chain reaches the subject. */
  proposedClosesCycle: boolean;
  allowAppOwned: boolean;
}): CorrectionPlan {
  if (input.currentSource === INVITER_SOURCE.APP && !input.allowAppOwned) {
    return { patch: null, outcome: 'app-owned' };
  }
  if (input.proposedInviterId !== null && input.proposedInviterId === input.subjectId) {
    return { patch: null, outcome: 'self' };
  }
  if (input.proposedInviterId !== null && input.proposedClosesCycle) {
    return { patch: null, outcome: 'cycle' };
  }
  const source = input.proposedInviterId === null ? null : INVITER_SOURCE.LEGACY_PARENT;
  if (input.currentInviterId === input.proposedInviterId && input.currentSource === source) {
    return { patch: null, outcome: 'already-ok' };
  }
  return {
    patch: { inviterId: input.proposedInviterId, inviterSource: source },
    outcome: 'applied',
  };
}
