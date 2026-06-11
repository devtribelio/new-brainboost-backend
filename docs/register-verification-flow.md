# Register verification flow — inactive-until-verified + placeholder reuse

Status: implemented 2026-06-11 (branch `feat/auth`). Supersedes the old behavior where
`/auth/register` auto-logged-in (returned a TokenBundle) and unverified members could
log in freely.

## Rules

1. **Members are born inactive.** Both register paths create the member with
   `isActive=false`, `isEmailVerified=false`, `isPhoneVerified=false`. The verify-OTP step is
   the activation point:
   - phone: `validateOtpPhone` → `isPhoneVerified=true, isActive=true`
   - email: `validateOtpEmail` → `isEmailVerified=true, isActive=true`
   - Activation never resurrects an account pending deletion (`scheduledDeletionAt != null`
     keeps `isActive=false`).
2. **Reusable placeholder.** A row may be overwritten by a fresh register with the same
   email/phone iff ALL of: `legacyId=null`, `isActive=false`, `isEmailVerified=false`,
   `isPhoneVerified=false`, `scheduledDeletionAt=null`. (`legacyId != null` = migrated
   legacy account: legacy had no OTP gate, so inactive legacy members would otherwise
   look like abandoned placeholders and be takeover-able.) Predicate: `isReusableUnverifiedMember`
   (`packages/common/src/utils/member-state.util.ts`). This is what lets a user who closed
   the app at the OTP screen register again instead of hitting "already registered".
   Reuse updates name/password/etc in place; `code`/`affiliateCode` stay as allocated;
   `autoJoinCommunityNetworks` is idempotent so no double-join/double-count.
3. **Login gate.** All login paths already reject `isActive=false` — unverified
   placeholders get a generic 401. A `403 ACCOUNT_NOT_VERIFIED` discriminator (with
   `details: { member_id, phone, email }`, only when the password matched) is written
   but **currently disabled** — commented out in `loginWithPassword`. Re-enable it if
   FE wants to route the user to the OTP screen from the login form.
4. **Phone re-register inside OTP TTL** (2 min): the previously sent WhatsApp code is
   still valid — the response returns its expiry instead of issuing a new OTP (would trip
   the resend guard, legacy errCode 2113, after the row was already updated).
5. **Social (Google) link path order:** `email_in_use_unverified` (400) is checked BEFORE
   `Member not active` (401), because placeholders are now also inactive and the
   unverified error is the actionable one.
6. **Email register issues OTP, not tokens.** `/auth/register` response changed from
   TokenBundle to `{ member_id, email, expired_date }` (mirror of `registerByPhone`).
   FE logs in via `/oauth/token` after validating. Per `docs/api-fe.md` #38 the email
   register endpoint is likely dead in the mobile app — verify with PM.

7. **Phone canonical form (added 2026-06-11).** Both register paths normalize via
   `normalizePhonePair` (`packages/common/src/utils/phone.util.ts`) BEFORE lookup/store:
   `phoneCode` → `+<digits>`; `phone` → digits only, leading 0 dropped, else a duplicated
   dial-code prefix stripped (`+62811…`/`62811…` → `811…`). Branch order mirrors legacy
   `sanitizePhone` — a leading 0 marks the rest as national, so `0622…` keeps its area
   code. `phoneTarget` normalizes defensively too (pre-normalization rows still hit the
   canonical OTP target). Password-grant login matches phone-shaped usernames against
   raw + canonical forms, so `08111…`/`628111…` log in to the member stored as `8111…`.
   Concurrent same-phone register: loser of the create race gets the same 400.

8. **Email is nullable — no synthetic placeholder (added 2026-06-11).** `Member.email`
   is `String? @unique` (migration `20260611000000_member_email_nullable`); phone-register
   creates the row with `email = NULL`. The old `phone-…@phone.brainboost.local` synthetic
   scheme (`SYNTHETIC_EMAIL_DOMAIN` / `isSyntheticEmail`) is removed; the migration nulls
   existing synthetic rows. Consequences:
   - Email-OTP endpoints guard `!member.email` → 400 "Member has no email on file"
     (was: `isSyntheticEmail` check on the pre-login pair only — post-login
     `requestVerifyEmail`/`verifyEmail` silently emailed the synthetic address).
   - Delete-account OTP falls back to the phone target (WhatsApp) when email is NULL —
     `deleteAccountOtpTarget` in `account.service.ts`; channel is routed by target shape.
   - JWT access-token claim stays `email: string` with `''` for email-less members
     (same convention as the anon client-credentials token).
   - Serializers now emit `email: null` for phone-only members — **FE must null-check**
     (was an ugly-but-non-null synthetic string). Confirm with FE/PM.
   - `scripts/migrate-from-legacy.ts` migrates email-less legacy members too (email OR
     phone required); phone is stored canonical via `normalizePhonePair` + `phoneCode`.

## API surface

| Endpoint | Change |
|---|---|
| `POST /auth/register` | **breaking**: inactive member + `verify-email` OTP; response `{member_id, email, expired_date}` |
| `POST /auth/registerByPhone` | inactive member; reuse guard (no more dead-end "Phone already registered" for placeholders) |
| `POST /auth/validateOtpPhone` | also sets `isActive=true` |
| `POST /auth/requestVerificationEmail` | **new** — pre-login resend `verify-email` OTP by memberId (no auth), mirror of `requestVerificationPhone` |
| `POST /auth/validateOtpEmail` | **new** — pre-login consume OTP by memberId, sets `isEmailVerified=true, isActive=true` |
| `POST /oauth/token` (password) | unverified placeholder → generic 401 (`403 ACCOUNT_NOT_VERIFIED` discriminator written but disabled) |
| `POST /account/preRegistration` | dedup check ignores reusable placeholders |
| `/auth/requestVerifyEmail`, `/auth/verifyEmail` | unchanged — post-login pair (phone-registered users adding a real email later) |
| `POST /auth/requestForgotPassword` + `forgotPasswordVerification` | accept `email?` OR `phone?` (both → email wins, same rule both steps); phone OTP via WhatsApp, target rebuilt canonical from the member row so input format may differ between steps; now rate-limited (max 5/day + resend guard, both channels) |

## Not done / follow-ups

- No cleanup cron for stale placeholders (they're reusable, so no dead-end, but rows linger).
- PraMember pre-registration OTP is still `verify`-only (not consumed) and `register` does
  not require it — pre-registration remains attribution capture, not a verification gate.
- Social login on an unverified placeholder could arguably take over the row (Google
  verified the email) — currently still `email_in_use_unverified`.

Tests: `apps/mobile-api/tests/auth-unverified-reuse.spec.ts`.
