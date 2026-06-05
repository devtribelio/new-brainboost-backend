# OTP Port (legacy → new)

Status of OTP across the rewrite. Legacy sources cited so each rule is
re-verifiable.

## Shared primitive

- **Generator:** legacy `TBGenerateCode::generateOtpCode($digits)` used PHP
  `rand()` (not crypto-secure). New `otp.service.ts` uses
  `crypto.randomInt(100000, 1000000)` — 6 digits, crypto-secure.
- **Storage:** bcrypt hash in `otp_codes` (`code` column). Never plaintext.
  Matches legacy `c::hash('bcrypt')->make()`.
- **Verify:** `bcrypt.compare`. New adds an **attempt counter** (5 wrong guesses
  → OTP invalidated); legacy had none.
- Service: `packages/common/src/services/otp.service.ts`
  (`issue` / `verify` / `consume`).

## Flows

| Flow | Purpose key | Channel | TTL | Status |
|---|---|---|---|---|
| Phone verify (register + resend) | `verify-phone` | WhatsApp (Qontak) | **2 min** | ✅ done |
| Email verify | `verify-email` | Email | 10 min | ✅ done (legacy had removed email OTP) |
| Forgot password | `forgot-password` | Email | 10 min | ✅ |
| Pre-registration | `pre-registration` | Email | 15 min | ✅ |
| Delete account | `delete-account` | Email | 1 min | ✅ |
| Withdraw | — | Email (legacy) | — | ❌ awaits disbursement module |

## Phone-OTP parity rules (legacy `TBApi_Member_Method_MemberRequestVerificationPhone`)

- **TTL 2 min** — legacy `CCarbon::now()->addMinutes(2)`. (`DEFAULT_TTL['verify-phone']`)
- **Daily cap 5/day** per member+phone — legacy counts unverified rows
  created today, rejects at ≥5. New: `otpService.issue({ maxPerDay: 5 })`,
  counted per `target`+`purpose` per calendar day.
- **Resend guard (errCode 2113)** — legacy rejects resend while an unverified,
  unexpired OTP exists. New: `otpService.issue({ enforceResendGuard: true })`.
- **Length 6 digits**, validated exact on verify.

These options are opt-in per call; only the phone flows pass them, so email
flows are unaffected.

## WhatsApp delivery (Qontak)

`packages/common/src/services/whatsapp.service.ts` ports
`TBQontak` / `TBQontak_Queue::send`:

- **Auth:** OAuth2 password grant → `POST {baseUrl}/oauth/token`
  (`client_id`, `client_secret`, `username`, `password`). Token cached.
- **Send:** `POST {baseUrl}/api/open/v1/broadcasts/whatsapp/direct` with
  `to_number`, `to_name`, `message_template_id`, `channel_integration_id`,
  `language.code`, `parameters.body[]` + optional URL `buttons[]`.
- **OTP template** (carried from legacy
  `TBQontak_Engine_MemberVerificationOtpPhoneNumber`): one body var + URL
  button, both = the OTP code.
  - default `channel_integration_id` = `9fe63a0f-e6c7-4a2e-b1ad-d12e69b5706c`
  - default `message_template_id`     = `453e330c-64d6-434c-ba3e-900afd0da366`
- **Fallback:** when `QONTAK_*` creds are empty, the service no-ops and logs
  the message (mirrors `mailer`), so dev/test boot without a live account.

### Env (production)

```
QONTAK_CLIENT_ID=...
QONTAK_CLIENT_SECRET=...
QONTAK_USERNAME=...
QONTAK_PASSWORD=...
# optional overrides — sensible legacy defaults baked in:
QONTAK_BASE_URL=https://service-chat.qontak.com
QONTAK_CHANNEL_INTEGRATION_ID=...
QONTAK_OTP_TEMPLATE_ID=...
```

## Phone normalization

`packages/common/src/utils/phone.util.ts` ports `TBUtils::sanitizePhone` /
`validPhone`: E.164 normalize (`+62…`), validity regex `^\+[0-9]{7,15}$`,
`toMsisdn` for Qontak's digits-only number. `whatsapp.service` rejects invalid
numbers before sending (legacy "Phone Number not valid").

## Pending

- 🔴 **Live Qontak QA** — the broadcast/token request shapes were reconstructed
  from the legacy PHP; not yet exercised against the live API. Needs sandbox
  creds + one manual send.
- 🔴 **Prod creds** — `QONTAK_*` unset → phone OTP silently no-ops in prod.
- ⚪ **Withdraw OTP** — folded into the disbursement module (not started).
- ⚪ **SMS provider** — `channel: 'sms'` in the DTO is advisory; legacy was
  WhatsApp-only, so this is parity, not a regression.
- ⚪ **Expired-row cleanup** — `otp_codes` rows are never GC'd (legacy didn't
  either). Add a sweep if the table grows.

## Tests

- `apps/mobile-api/tests/otp-service.spec.ts` — 2-min TTL, resend guard,
  resend-after-consume, 5/day cap.
- `apps/mobile-api/tests/phone-util.spec.ts` — sanitize/valid/msisdn table.
- `apps/mobile-api/tests/auth-phone-otp.spec.ts` — register → verify HTTP flow
  (dispatcher spied to capture the code), wrong-code → 400.
