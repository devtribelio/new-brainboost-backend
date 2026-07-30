# OTP resend cooldown — spec

Status: **implemented** (2026-07-30). Supersedes the `enforceResendGuard` model.

## Why

TTL used to carry three jobs at once:

1. how long a code stays redeemable,
2. how long a resend is blocked (`enforceResendGuard` checked `expiresAt > now`),
3. how fast the daily cap could be spent.

Because of (2), a `forgot-password` user whose WhatsApp/email never arrived had to
wait the **full 10 minutes** before requesting another code — while the error copy
said "tunggu sebentar". Shortening the TTL to fix the wait would have made codes
die before they arrived (relay poll 2s + SES/Qontak + the user reading and typing).

The fix decouples the two: **TTL is unchanged**, cooldown is its own number.

## Model

| Knob | Value | Where |
|---|---|---|
| Resend cooldown | **60s**, measured from the previous row's `createdAt` | `OTP_RESEND_COOLDOWN_SECONDS` |
| Send cap (WhatsApp) | 5 per rolling 24h | `OTP_MAX_PER_DAY.whatsapp` |
| Send cap (email) | 10 per rolling 24h | `OTP_MAX_PER_DAY.email` |
| TTL | unchanged (`DEFAULT_TTL`) | 1m delete-account · 2m verify-phone · 10m forgot-password / verify-email · 15m pre-registration |

All in `packages/common/src/services/otp.service.ts`.

Three properties worth stating explicitly:

- **Cooldown ignores redemption state.** What is throttled is the outbound
  message, so consuming a code does not lift the cooldown (the old guard was
  released by a `consume()`, and also by a lockout — see below).
- **Both knobs are opt-OUT, not opt-in.** Every caller that had to opt in forgot
  to: four of the eight send endpoints shipped with no throttle at all. Defaults
  now apply unless a call site passes `0`.
- **The cap window is rolling 24h.** It was a server-local calendar day
  (`setHours(0,0,0,0)`), which depended on the container timezone — a UTC
  container reset the budget at 07:00 WIB — and allowed `maxPerDay` just before
  midnight plus another `maxPerDay` right after.

## Superseding

`issue()` now retires every live row for the target+purpose (sets `usedAt`)
inside the same transaction that writes the new one. Required, not cosmetic:
with a 60s cooldown under a multi-minute TTL, two live codes became the normal
case, and `resolveAndMatch` only ever reads the newest. That left the older row
unreachable for a legitimate user but **reachable again the moment the newest
was locked** by `MAX_OTP_ATTEMPTS` — a fresh 5-guess budget for an attacker.

`usedAt` doubles as the superseded marker: there is no column for it, and both
states mean exactly "no longer redeemable".

A code that matches a recently retired row is answered `OTP_EXPIRED` **without
charging an attempt** (`matchesSupersededCode`, bounded to the last 2 retired
rows, failure path only). Without it, a resend racing a slow first message makes
the user's legitimately-received code read as `OTP_INVALID` and spend the live
code's budget.

## `issue()` vs `issueOrReuse()`

| Use | When |
|---|---|
| `issue()` | pure send endpoints — `requestVerification*`, `requestForgotPassword`, `requestVerify`, `preRegistration`, `requestDeleteAccount`. Inside the cooldown the user is told to wait. |
| `issueOrReuse()` | `register` and `registerByPhone`. Both overwrite an unverified placeholder row *before* sending, so a 400 would strand the client on a write that already landed. Inside the cooldown, the still-live code's expiry is returned instead. |

`registerByPhone` previously had an inline version of this scoped to the full
TTL; it now shares the helper and the cooldown window.

## Endpoint matrix (after)

| Endpoint | Cooldown | Cap/24h | Rate limiter |
|---|---|---|---|
| `POST /auth/register` | 60s (reuse) | 10 | 15/15m |
| `POST /auth/registerByPhone` | 60s (reuse) | 5 | 15/15m |
| `POST /auth/requestForgotPassword` | 60s | 5 or 10 by channel | 10/15m |
| `POST /auth/requestVerificationPhone` | 60s | 5 | 10/15m |
| `POST /auth/requestVerificationEmail` | 60s | 10 | 10/15m |
| `POST /auth/requestVerify` | 60s | 5 or 10 by channel | — (authGuard) |
| `POST /account/preRegistration` | 60s | 10 | **10/15m (new)** |
| `POST /account/requestDeleteAccount` | 60s | 5 (explicit) | **5/15m (new)** |

`/account/preRegistration` was unauthenticated with no throttle of any kind and
mails whatever address is posted — an open relay for mailbombing a third party.
That is what the new limiter closes.

## Client-visible changes

- `OTP_RESEND_TOO_SOON` details gain `retryAfterSeconds` alongside the existing
  `retryAfter` ISO timestamp, so a countdown can be rendered. `OTP_DAILY_LIMIT_REACHED`
  now carries both too (it previously carried nothing).
- `OTP_DAILY_LIMIT_REACHED` copy: "coba lagi besok" → "coba lagi dalam 24 jam"
  (the window is no longer a calendar day).
- Entering a superseded code returns `OTP_EXPIRED` where it used to return
  `OTP_INVALID`. Worth flagging to the mobile team — the contract is unchanged,
  but the code shown to a user in that scenario differs.

## Known, unchanged

- **`/auth/validateOtp` uses `verify()`, not `consume()`** (`auth.service.ts`), so
  it never sets `usedAt` — that code stays redeemable until its TTL elapses and
  can be replayed within the window. Pre-existing; likely deliberate (register
  validates first and completes later), but not verified.
- **No retention on `otp_codes`.** The table has never been pruned and holds
  `target` (email / phone — PII) plus bcrypt hashes indefinitely. Its only index
  is `@@index([target, purpose])`, so `orderBy createdAt desc` sorts a target's
  whole history on each verify. A prune job (e.g. `createdAt < now() - 30d`)
  belongs with the others in `packages/domain/src/jobs/`.
- **Check-then-act.** Cooldown and cap are read-then-insert with no unique
  constraint or lock, so two truly concurrent requests can both pass. Cost is one
  duplicate message; the superseding logic keeps state consistent afterwards.
