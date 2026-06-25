# External tester account (fixed-OTP bypass)

Lets a designated tester (e.g. the Apple App Review reviewer) pass OTP-gated
flows using the fixed code **`000000`** instead of a real OTP they can't receive.

## Why this exists

App Review tests the **production** build, so the reviewer hits the prod API.
Password login (`grant_type=password`) needs no OTP, but other flows do —
notably **account deletion** (Apple requires in-app deletion, and reviewers test
it), fresh **registration**, and in-app **re-verify**. Those are OTP-gated, and
the reviewer can't receive a WhatsApp/email OTP sent to a dummy contact.

A real OTP can never be `000000` — codes are `randomInt(100000, 1000000)`, always
6 digits with no leading zero — so `000000` is a safe sentinel.

## How it works

All OTP verification funnels through `OtpService` in
`packages/common/src/services/otp.service.ts`. When the target is a whitelisted
tester and the bypass is enabled:

- `issue()` — **skips everything**: no `otp_codes` row, no comms delivery. This
  also sidesteps the resend guard + daily cap, so the reviewer can retry freely.
- `verify()` / `consume()` — accept `000000` directly (no bcrypt, no expiry
  check). A wrong code still fails. Non-whitelisted targets are untouched.

Config is read live from env (`testAccountConfig()` in `config/env.ts`), so it
can be toggled at runtime without a rebuild.

## Setup

1. **Create the account** (idempotent upsert):

   ```bash
   TEST_ACCOUNT_SEED_PASSWORD='<strong-pw>' \
   TEST_ACCOUNT_SEED_EMAIL='appreview@brainboost.test' \
   TEST_ACCOUNT_SEED_PHONE='628111222333' \
   pnpm seed:test-account
   ```

   Creates a `Member` with `isActive=true`, verified flags set. Give the reviewer
   the email/phone + password.

2. **Enable the bypass** for that identifier (env):

   ```env
   TEST_ACCOUNT_ENABLED=true
   TEST_ACCOUNT_OTP_CODE=000000
   # comma-separated. Emails matched case-insensitively. Phones matched by DIGITS
   # only — the OTP target is canonical E.164 ('+628111…'), but any equivalent
   # form works ('628111222333', '+628111222333', '+62 8111 2333' all match).
   TEST_ACCOUNT_IDENTIFIERS=appreview@brainboost.test,628111222333
   ```

   > If you still get "Invalid OTP": the env must be set in the real `.env`
   > (not just `.env.example`) **and the server restarted** — `.env` is loaded
   > into `process.env` once at boot. Confirm `TEST_ACCOUNT_ENABLED=true` and that
   > the identifier's digits match the member's phone (or the email matches exactly).

3. To **disable** after review: set `TEST_ACCOUNT_ENABLED=false` (no code change
   or redeploy of logic needed — it's read live).

## Security rules

- **Kill-switch defaults OFF** (`TEST_ACCOUNT_ENABLED` defaults to `false`).
- **Whitelist only dummy accounts.** If a real user's email/phone is listed,
  `000000` could reset their password via forgot-password. The bypass spans all
  OTP purposes by design.
- The whitelist is exact-match against the OTP target string — no wildcards.
