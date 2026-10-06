/**
 * Pure rules for the connect syncer's inviter write (PRD P0-1).
 *
 * Legacy `member_network_connect` = the affiliator a brainboost buyer was "connected" to on
 * their first purchase (TBModel_MemberNetworkConnect::findOrCreate, insert-once). Legacy
 * commission (TBAffiliator_Commision_CoursePayment) pays THAT affiliator when the payment
 * carries no cookie code — so it outranks the member_network parent for commission purposes.
 *
 * Shared rules (both variants):
 * - `APP` (and any unknown source) is never touched; we own NULL / LEGACY_PARENT /
 *   LEGACY_CONNECT only.
 * - Self-connect (affiliator resolves to the subject) is ignored: the parent stays.
 * - A connect whose affiliator's 4-level chain reaches the subject is rejected (cycle).
 * - Removal (legacy status=0, or a connect that became self via dedup) only undoes what
 *   the connect sync wrote (source LEGACY_CONNECT): back to the resolved legacy parent
 *   (source LEGACY_PARENT); with no usable parent the inviter is cleared ONLY when it
 *   still equals the removed connect — anything else is left alone.
 *
 * The one open product choice (`variant`):
 * - 'A': the connect affiliator always wins.
 * - 'C': like A, except when connect ≠ legacy parent AND the member has legacy downlines →
 *   keep the parent (no write) and WARN for review; a member already flipped to its
 *   connect that gains downlines later is NOT flipped back (logged only).
 */
import { INVITER_SOURCE, type InviterPatch } from './inviter-rules';

export type ConnectVariant = 'A' | 'C';

export interface ConnectInput {
  subjectId: string;
  current: { inviterId: string | null; inviterSource: string | null };
  /** legacy member_network_connect.status = 1 */
  connectActive: boolean;
  /** resolved connect affiliator; undefined = not resolvable to a member */
  affiliatorId: string | undefined;
  /** resolved legacy member_network parent (self already climbed past); null = none / unresolved */
  parentId: string | null;
  /** the subject's legacy member_network node(s) have children */
  hasDownlines: boolean;
  connectClosesCycle: boolean;
  parentClosesCycle: boolean;
}

export type ConnectReason =
  | 'self-connect'
  | 'unresolved'
  | 'cycle'
  | 'downlines'
  | 'downlines-later'
  | 'reverted'
  | 'revert-cleared'
  | 'revert-kept';

export interface ConnectPlan {
  patch: InviterPatch | null;
  reason?: ConnectReason;
}

const OWNED_SOURCES: ReadonlyArray<string | null> = [
  null,
  INVITER_SOURCE.LEGACY_PARENT,
  INVITER_SOURCE.LEGACY_CONNECT,
];

function planRevert(input: ConnectInput): ConnectPlan {
  const { subjectId, current, parentId, affiliatorId } = input;
  if (parentId && parentId !== subjectId && !input.parentClosesCycle) {
    return { patch: { inviterId: parentId, inviterSource: INVITER_SOURCE.LEGACY_PARENT }, reason: 'reverted' };
  }
  if (current.inviterId === affiliatorId || current.inviterId === subjectId) {
    return { patch: { inviterId: null, inviterSource: null }, reason: 'revert-cleared' };
  }
  return { patch: null, reason: 'revert-kept' };
}

export function decideConnectWrite(input: ConnectInput, variant: ConnectVariant): ConnectPlan {
  const { subjectId, current, affiliatorId } = input;
  if (!OWNED_SOURCES.includes(current.inviterSource)) return { patch: null };
  const ownedByConnect = current.inviterSource === INVITER_SOURCE.LEGACY_CONNECT;

  const selfConnect = input.connectActive && affiliatorId === subjectId;
  if (!input.connectActive || selfConnect) {
    if (ownedByConnect) return planRevert(input);
    return selfConnect ? { patch: null, reason: 'self-connect' } : { patch: null };
  }

  if (affiliatorId === undefined) return { patch: null, reason: 'unresolved' };
  if (ownedByConnect && current.inviterId === affiliatorId) return { patch: null };
  if (input.connectClosesCycle) return { patch: null, reason: 'cycle' };

  if (variant === 'C' && affiliatorId !== input.parentId && input.hasDownlines) {
    return { patch: null, reason: ownedByConnect ? 'downlines-later' : 'downlines' };
  }
  return { patch: { inviterId: affiliatorId, inviterSource: INVITER_SOURCE.LEGACY_CONNECT } };
}
