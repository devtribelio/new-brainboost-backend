/**
 * Field-level rules for `ensureMember`'s ADOPT path (audit 07 #9).
 *
 * A member that registered in the app first (placeholder, `legacyId=null`) can later collide
 * with the matching legacy row on a strong key (email / Google / Apple sub). We take the
 * legacy `legacyId` onto that row, but the placeholder may already hold verified/active state
 * and profile data the member entered in the app — the resync must never downgrade it.
 *
 * So the adopt write is:
 *   - identity fields: fill only when the placeholder has none (a strong-key match already
 *     guarantees the matched key agrees, so nothing needs overwriting);
 *   - profile (`fullName`/`avatarUrl`/`bio`): fill only when empty;
 *   - `isActive` / verified: only ever raised (OR), never lowered;
 *   - bank: only when the placeholder has no account;
 *   - `affiliateCode` is deliberately NOT here — the code sync path never replaces an
 *     existing code (a differing legacy code becomes an alias instead).
 */

export interface AdoptExisting {
  email: string | null;
  phone: string | null;
  googleSub: string | null;
  appleSub: string | null;
  fullName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  isActive: boolean;
  isEmailVerified: boolean;
  isPhoneVerified: boolean;
  bankAccountNumber: string | null;
}

export interface AdoptLegacy {
  email: string | null;
  phone: string | null;
  phoneCode: string | null;
  googleSub: string | null;
  appleSub: string | null;
  fullName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  isActive: boolean;
  isEmailVerified: boolean;
  isPhoneVerified: boolean;
  bank: Record<string, unknown> | null;
}

const filled = (v: string | null): boolean => v !== null && v !== '';

export function planAdopt(existing: AdoptExisting, legacy: AdoptLegacy): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  // identity: fill-if-null only (the placeholder's own values win). Verification only ever
  // follows a key that actually matches — a Google/Apple match can have a different email.
  if (!existing.email && legacy.email) {
    data.email = legacy.email;
    if (legacy.isEmailVerified) data.isEmailVerified = true;
  } else if (existing.email === legacy.email && legacy.isEmailVerified && !existing.isEmailVerified) {
    data.isEmailVerified = true;
  }
  if (!existing.phone && legacy.phone) {
    data.phone = legacy.phone;
    data.phoneCode = legacy.phoneCode;
    if (legacy.isPhoneVerified) data.isPhoneVerified = true;
  } else if (existing.phone === legacy.phone && legacy.isPhoneVerified && !existing.isPhoneVerified) {
    data.isPhoneVerified = true;
  }
  if (!existing.googleSub && legacy.googleSub) data.googleSub = legacy.googleSub;
  if (!existing.appleSub && legacy.appleSub) data.appleSub = legacy.appleSub;

  // profile: fill-if-empty
  if (!filled(existing.fullName) && legacy.fullName) data.fullName = legacy.fullName;
  if (!filled(existing.avatarUrl) && legacy.avatarUrl) data.avatarUrl = legacy.avatarUrl;
  if (!filled(existing.bio) && legacy.bio) data.bio = legacy.bio;

  // never downgrade activation
  if (legacy.isActive && !existing.isActive) data.isActive = true;

  // bank: only when the placeholder has no account
  if (legacy.bank && existing.bankAccountNumber === null) Object.assign(data, legacy.bank);

  return data;
}
