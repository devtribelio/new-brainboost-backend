/**
 * How a legacy member that is being materialised relates to the Postgres member it
 * collided with on a unique identity field (email / phone / googleSub / appleSub).
 *
 * The rule (PRD P0-5): only a STRONG identity — the same email, or the same Google /
 * Apple subject — is evidence that two rows are one person. A shared phone number on
 * its own is not: legacy took numbers from forms that never proved them, and the audit
 * found 342/373 redirects were phone-only, with ~87 pairs plainly different people.
 * Merging those hands one person's purchases, commissions and login to another. So a
 * phone-only collision never redirects and never adopts — the legacy member becomes a
 * member of its own WITHOUT the phone (`members.phone` is unique, so the number stays
 * with whoever already holds it) and the pair is logged for a human to review.
 */

export interface IdentityKeys {
  email: string | null;
  phone: string | null;
  googleSub: string | null;
  appleSub: string | null;
}

export interface ExistingMember extends IdentityKeys {
  legacyId: number | null;
}

export type IdentityDecision =
  /** no collision → create a fresh member */
  | 'create'
  /** the row already IS this legacy member (race) → just map it */
  | 'map'
  /** strong match with another migrated winner → this legacy id is a dedup loser */
  | 'redirect'
  /** strong match with a new-app placeholder (legacyId null) → stamp legacyId onto it */
  | 'adopt'
  /** phone is the only shared key → create a separate member without the phone */
  | 'separate_without_phone';

const same = (a: string | null, b: string | null): boolean => a !== null && b !== null && a === b;

/** True when the two rows share an email or a provider subject. */
export function isStrongMatch(legacy: IdentityKeys, existing: IdentityKeys): boolean {
  return (
    same(legacy.email, existing.email) ||
    same(legacy.googleSub, existing.googleSub) ||
    same(legacy.appleSub, existing.appleSub)
  );
}

export function decideIdentityMatch(
  legacyId: number,
  legacy: IdentityKeys,
  existing: ExistingMember | null,
): IdentityDecision {
  if (!existing) return 'create';
  if (existing.legacyId === legacyId) return 'map';
  if (isStrongMatch(legacy, existing)) return existing.legacyId === null ? 'adopt' : 'redirect';
  if (same(legacy.phone, existing.phone)) return 'separate_without_phone';
  // matched on nothing we compare (should not happen: the lookup is by these keys)
  return 'create';
}

/**
 * After a split, the winner keeps the KYC its legacy row never owned: `applyKycDecisions`
 * only writes members that have their OWN APPROVED/REJECTED legacy row, so a winner whose
 * status came from the loser stays APPROVED with the loser's bank account attached
 * (audit 08 F12). When the winner has no own legacy KYC and its status is LEGACY-sourced,
 * the split must hand it back and reset to NONE. App-owned KYC (MANUAL/DIDIT/…) is never
 * touched, and neither is a winner that has its own legacy KYC.
 */
export function shouldResetBorrowedWinnerKyc(input: {
  loserRows: number;
  winnerRows: number;
  winnerSource: string | null;
}): boolean {
  return input.loserRows > 0 && input.winnerRows === 0 && input.winnerSource === 'LEGACY';
}
