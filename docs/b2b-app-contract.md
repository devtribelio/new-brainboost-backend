# Company (B2B) app — backend contract

Status: implemented on `feat/b2b-app` (mobile-api). Audience: mobile team building the
company app. PRD: `brainboost-b2b-be/.claude/prds/b2b-db-consolidation.prd.md` §App B2B.

The company app is a separate store app. It uses **the same Member account** as the
regular Brainboost app (same email / password / OTP / Google / Apple), shows only the
courses a company grants, and never shows prices, vouchers or a shop.

## 1. Identify as the company app

| Where | Value | Effect |
|---|---|---|
| Header on every request | `x-app: b2b` | Required on `POST /api/member/auth/devices` and `POST /api/member/auth/cloudMessaging`: the device is stored as a company-app device. |
| Body `client_type` on `POST /api/member/oauth/token` (password, social, refresh) | `"b2b"` | Company-app session bucket. Logging in here only signs out the company app on the member's other phone; the regular app stays signed in. |

Missing / other values keep today's behaviour (regular app), so builds already in the
stores are unaffected.

## 2. First login

| Account | How to sign in |
|---|---|
| Member already has a Brainboost account | Same credentials as the regular app. |
| Account created by the company (invited employee, no password yet) | **"Set password"** = forgot-password OTP: `POST /api/member/auth/requestForgotPassword { email }` → code by email → `POST /api/member/auth/forgotPasswordVerification { email, code, newPassword }` → then log in with `client_type: "b2b"`. This also verifies the email, after which Google sign-in with that email works too. |
| Company-created account, Google first | Fails with `EMAIL_IN_USE_UNVERIFIED` until the email is verified — route the user to "Set password". |

Password reset signs the member out of every app (existing security behaviour).

## 3. Endpoints (all `Authorization: Bearer <access_token>`)

A company is visible only while the member holds an **active seat** there (active grant
on an active plan). Any `:companyId` the member has no seat at — unknown, foreign,
expired or malformed — returns the same **404** `B2B_COMPANY_NOT_FOUND`.

### `GET /api/b2b-app/companies`
Companies for the picker. 0 → show "Belum ada akses dari perusahaan" (no link to any
shop); 1 → enter directly; >1 → let the user choose (and switch later from a menu).
```json
{ "data": [
  { "company_id": "f5f98d56-…", "display_name": "PT Jaya Academy",
    "logo_url": "https://…/public/branding/jaya.png", "primary_color": "#0F766E",
    "course_count": 6 } ] }
```

### `GET /api/b2b-app/companies/:companyId`
Theme + announcements active now.
```json
{ "data": {
  "company_id": "f5f98d56-…", "display_name": "PT Jaya Academy",
  "logo_url": "https://…/jaya.png", "primary_color": "#0F766E",
  "welcome_text": "Selamat belajar, tim Jaya!",
  "announcements": [
    { "id": "a1", "title": "Program Q4", "body": "Selesaikan modul Leadership",
      "starts_at": "2026-10-01", "ends_at": "2026-11-30" } ] } }
```
`display_name` falls back to the company's legal name; `logo_url` / `primary_color` /
`welcome_text` may be `null` → use app defaults.

### `GET /api/b2b-app/companies/:companyId/courses`
The home screen. Groups and order come from the company's layout; courses not placed
in a group appear in a trailing group `"Kursus"`. **No price fields, ever.** A course
the member bought personally is shown here only if the company grants it too.
```json
{ "data": { "groups": [
  { "title": "Wajib", "courses": [
    { "course_id": 3867, "course_uuid": "…", "product_id": "…",
      "title": "Money Magnet", "thumbnail": "https://…", "duration_min": 95,
      "access": { "active": true, "expires_at": "2027-05-03T00:00:00.000Z" },
      "progress": 0.42 } ] } ] } }
```
`access.active = false` → the seat ended (or has not been projected yet); show the
course as locked without any purchase CTA. Playing a course uses the existing
endpoints (`/api/member/product/course/detail`, `/api/media/*`, tracker, streak) —
access there is decided by the same enrollment.

## 4. Push

- Company-app devices receive only: streak reminders (sent to both apps) and, later,
  company-access messages. Community (posts, topics, networks, digests) and promo
  pushes are never sent to the company app.
- Members whose account the company created (`signup_source = 'b2b'`) get no
  community/promo push, no promo banners and no first-purchase voucher in the regular
  app while they hold a company seat. The exclusion ends automatically when the last
  seat ends.
