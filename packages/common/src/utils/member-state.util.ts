export interface MemberVerificationState {
  legacyId: number | null;
  isActive: boolean;
  isEmailVerified: boolean;
  isPhoneVerified: boolean;
  scheduledDeletionAt: Date | null;
}

/**
 * A member row is a reusable register placeholder when it never completed any
 * verification (email or phone) and is not an account pending deletion.
 *
 * Register flow rule: members are created `isActive=false` and only activated
 * by the verify-OTP step. A row matching this predicate may be overwritten by
 * a fresh register attempt with the same email/phone — this is what lets a
 * user who abandoned the OTP screen register again instead of hitting
 * "already registered". A `scheduledDeletionAt` set means the row belongs to a
 * real (deactivated) account and must never be reused by a stranger.
 *
 * `legacyId != null` means the row was migrated from the legacy platform —
 * a real account regardless of its verification flags (legacy had no OTP
 * verification gate; inactive legacy members would otherwise look like
 * abandoned placeholders and be takeover-able by a fresh register).
 */
export function isReusableUnverifiedMember(member: MemberVerificationState): boolean {
  return (
    member.legacyId === null &&
    !member.isActive &&
    !member.isEmailVerified &&
    !member.isPhoneVerified &&
    member.scheduledDeletionAt === null
  );
}
