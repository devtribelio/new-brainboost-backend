/**
 * Domain suffix of the synthetic placeholder email assigned by phone-register
 * (Member.email is NOT NULL + unique, but phone-register collects no email).
 */
export const SYNTHETIC_EMAIL_DOMAIN = '@phone.brainboost.local';

export function isSyntheticEmail(email: string): boolean {
  return email.endsWith(SYNTHETIC_EMAIL_DOMAIN);
}

export interface MemberVerificationState {
  isActive: boolean;
  isVerified: boolean;
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
 */
export function isReusableUnverifiedMember(member: MemberVerificationState): boolean {
  return (
    !member.isActive &&
    !member.isVerified &&
    !member.isPhoneVerified &&
    member.scheduledDeletionAt === null
  );
}
