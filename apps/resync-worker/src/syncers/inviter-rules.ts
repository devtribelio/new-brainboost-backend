/**
 * Pure rules for the tree syncer's inviter write (members.inviter_id + inviter_source).
 *
 * - Self-inviter (P0-4): a legacy parent node can belong to a dedup LOSER of the same
 *   person, so it resolves (via member_redirect) to the subject itself. Climb to the
 *   parent of that node instead, bounded; give up rather than write self.
 * - Cycles: never write an inviter whose own PG chain reaches the subject within
 *   CYCLE_CHECK_LEVELS (the commission walk is 4 levels deep).
 * - Ownership (P1-7): the tree only overwrites an inviter it owns (source NULL or
 *   LEGACY_PARENT) — never one the new app or the connect sync set — and never writes
 *   NULL over a non-null inviter, except to clear a self-inviter.
 */

export const INVITER_SOURCE = {
  LEGACY_PARENT: 'LEGACY_PARENT',
  LEGACY_CONNECT: 'LEGACY_CONNECT',
  APP: 'APP',
} as const;

/** Extra legacy ancestors tried past the direct parent when it resolves to the subject. */
export const MAX_CLIMB_HOPS = 5;
/** Inviter levels above the candidate checked for the subject (= commission depth). */
export const CYCLE_CHECK_LEVELS = 4;

export type InviterPick =
  | { status: 'ok'; inviterId: string; hops: number }
  | { status: 'unresolved' } // an ancestor exists in legacy but isn't a migrated member
  | { status: 'self' }; // every ancestor within the bound is the subject (or none left)

/**
 * `ancestors[0]` = resolved direct parent, `[1]` = its parent, … (undefined = not
 * materialised). Self entries are skipped; the first other member wins.
 */
export function pickInviter(subjectId: string, ancestors: ReadonlyArray<string | undefined>): InviterPick {
  const bounded = ancestors.slice(0, MAX_CLIMB_HOPS + 1);
  for (let hops = 0; hops < bounded.length; hops += 1) {
    const id = bounded[hops];
    if (id === undefined) return { status: 'unresolved' };
    if (id !== subjectId) return { status: 'ok', inviterId: id, hops };
  }
  return { status: 'self' };
}

/** `chain[0]` = candidate's inviter, `[1]` = its inviter, … */
export function chainHitsSubject(subjectId: string, chain: ReadonlyArray<string | null>): boolean {
  return chain.slice(0, CYCLE_CHECK_LEVELS).includes(subjectId);
}

export function mayOverwriteInviter(currentSource: string | null): boolean {
  return currentSource === null || currentSource === INVITER_SOURCE.LEGACY_PARENT;
}

export interface InviterPatch {
  inviterId: string | null;
  inviterSource: string | null;
}

export interface InviterPlan {
  patch: InviterPatch | null;
  reason?: 'climbed' | 'self' | 'cycle';
}

export function planInviterWrite(input: {
  subjectId: string;
  current: { inviterId: string | null; inviterSource: string | null };
  /** null = the legacy row has no parent. */
  pick: InviterPick | null;
  createsCycle: boolean;
}): InviterPlan {
  const { subjectId, current, pick, createsCycle } = input;
  if (!mayOverwriteInviter(current.inviterSource)) return { patch: null };

  if (pick?.status === 'ok' && !createsCycle) {
    const patch = { inviterId: pick.inviterId, inviterSource: INVITER_SOURCE.LEGACY_PARENT };
    return pick.hops > 0 ? { patch, reason: 'climbed' } : { patch };
  }

  // nothing writable: keep the current inviter, unless it is the subject itself
  const patch = current.inviterId === subjectId ? { inviterId: null, inviterSource: null } : null;
  if (pick?.status === 'self') return { patch, reason: 'self' };
  if (pick?.status === 'ok') return { patch, reason: 'cycle' };
  return { patch };
}
