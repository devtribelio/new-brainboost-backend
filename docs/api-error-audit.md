# API Error Audit (2026-07-30)

Sweep of every error message the API returns to the mobile client: 317 `throw` sites across `apps/mobile-api` + `packages/{common,domain}`, plus `error.middleware.ts`, `rate-limit.middleware.ts`, and the webhook controller.

Companion spec: `docs/api-envelope.md` (envelope + error code vocabulary).

---

## Fixed in this pass

### 1. `error.code` made branchable (finding #1 — the inverted contract)

`docs/api-envelope.md` promises "`error.code` for branching, `error.message` for display". Only 1 of 317 throw sites passed a code, so `code === statusToCode(status)` always held — zero information beyond the status line — while `message` carried the discriminator. See `docs/api-envelope.md` § "Why Tier 2 exists" for the full write-up.

- Added `packages/common/src/exceptions/error-codes.ts` — `ERROR_CODES` catalog + `ErrorCode` type.
- `Unauthorized/Forbidden/NotFoundException` gained the optional trailing `code` param `BadRequestException` already had.
- Codes applied to **all 317 sites**, plus the error middleware, the Prisma mapper and the rate limiter.
- `apps/mobile-api/tests/error-codes.spec.ts` pins codes + catalog integrity.

Landed in two steps on purpose: codes first (additive, messages untouched — a client still matching on `message` kept working), then the translation below. That ordering is what made translating safe at all.

Nine existing specs asserted the old generic `'UNAUTHORIZED'` and were updated to the specific codes. Worth noting: those tests were asserting precisely the redundant bit (`code` re-derived from `status`), which is part of why the inversion went unnoticed.

### 2. `/admin*` returned HTML instead of the JSON envelope (real bug)

`error.middleware.ts` still had `isAdminRequest()` → `res.render('admin/error', …)`, a leftover from `apps/admin-ejs` (removed 2026-07). `mobile-api` registers no view engine and mounts all modules under `/api`, so **every** `/admin/...` request hit `notFoundHandler` → `renderAdminError` → `res.render` threw → Express `finalhandler` replied with HTML.

Reproduced against the repo's express version:

| NODE_ENV | Result |
|---|---|
| non-production | `404 text/html` + full Node stack trace (absolute paths, `node_modules` internals) |
| production | `404 text/html` `<pre>Not Found</pre>` |

So: envelope violated in all environments, and a stack leak in dev/staging that bypassed the otherwise-correct `!env.isProduction` guard below it. `isAdminRequest` + `renderAdminError` deleted; regression test in `error-codes.spec.ts`.

### 3. All user-facing copy translated to Indonesian (findings #6 + #2 + #8)

`packages/common/src/exceptions/error-messages.ts` — one Indonesian sentence per code, typed `Record<ErrorCode, string>` so a code without copy cannot compile. `factory.ts` exposes `badRequest`/`unauthorized`/`forbidden`/`notFound`, which look the copy up by code; **no call site writes a literal message any more** (verified: zero literals left in production code).

This resolved three separate findings at once:

- **Mixed languages.** Was ~308 English + 9 Indonesian (the Indonesian all in KYC/disbursement plus one in profile). Now uniformly Indonesian, so a user can no longer get `Rekening belum diisi` followed by `You already have a pending withdrawal` on the same payout screen.
- **Machine tokens in `message`.** `session_revoked`, `invalid_refresh_token`, `refresh_token_expired`, `google_email_not_verified`, `email_in_use_unverified`, `invalid_google_id_token`, `invalid_apple_id_token` — each is now a `code`, with human copy in `message`. The commented-out `HttpException(403, 'ACCOUNT_NOT_VERIFIED', …)` at `auth.service.ts:453` showed the intended shape all along.
- **Internal enums / timestamps / raw input in copy.** `Transaction is ${status}`, `Request already ${status}`, `Content exceeds ${MAX} characters`, `File extension "${ext}"`, the OTP retry-after ISO string — all moved to `details` (`{ status }`, `{ max }`, `{ extension }`, `{ retryAfter }`, …). Messages no longer leak field names, enum values or client input.

Dedup came for free: `Member not found` appeared 24× and `Member is not active` under four different statuses; each is now one code with one sentence.

Also fixed: the 429 responder had its own English constant (`rate-limit.middleware.ts`) outside the catalog — it now goes through `TOO_MANY_REQUESTS`. `notImplemented()` (501) is still English but has **zero call sites**, so it was left alone.

**This was breaking for the client.** Frontend handoff with the full old → new mapping, the HTTP status vocabulary and a migration checklist: `docs/frontend-error-contract-migration.md`.

---

## Outstanding (not touched — needs a decision)

### 1. ~~Mixed ID/EN messages~~ — DONE, see "Fixed" §3
~310 English, 9 Indonesian — all concentrated in KYC/disbursement plus one in profile:

| Location | Message |
|---|---|
| `disbursement.service.ts:111` | `Saldo belum mencukupi untuk verifikasi KYC` |
| `disbursement.service.ts:193` | `KYC perlu diperbarui` / `KYC belum disetujui` |
| `disbursement.service.ts:197` | `Rekening belum diisi` |
| `disbursement.service.ts:264` | `Pencairan besar memerlukan verifikasi KYC ulang` |
| `disbursement.service.ts:475` | `KYC sedang ditinjau` |
| `disbursement.service.ts:476,543` | `KYC sudah disetujui` |
| `profile.service.ts:66` | `Email sudah terverifikasi dan tidak dapat diubah` |

On one screen (payout) a user can get `Rekening belum diisi` then `You already have a pending withdrawal`. Voucher failures reach the user fully in English: reasons from `voucher.service.ts:25-39` pass through `checkout.service.ts:45` into `message`.

_Resolved. Kept here for the record of what the state was._

### 2. ~~Machine tokens in `message`~~ — DONE, see "Fixed" §3

### 3. Same condition → different HTTP status
"member inactive" answers with **four** different statuses:

| Status | Location |
|---|---|
| 404 | `member.service.ts:33`, `profile.service.ts:18,35` |
| 401 | `account.service.ts:185`, `auth.service.ts:129,133,135,661` |
| 403 | `network.service.ts:131`, `post.service.ts:212`, `comment.service.ts:181` |
| 400 | `topic.service.ts:115` |

Also: "network inactive" is 403 at `post.service.ts:333` but 400 at `post.service.ts:358` (same file); `network.service.ts:270` returns 400 for `Network not found` while lines 34/35/41 return 404; `product.controller.ts:141` returns 400 for product-not-found while `product.service.ts:293` returns 404.

Pick one canonical status per condition, then align. Note a 400-vs-404 split no longer hurts clients that branch on `code`.

### 4. Developer-facing text shown to end users
Raw internal param names in `message`: `postId required`, `commentId required`, `scope and refId required`, `programCode and affiliatorCode required`, `requestId or (networkId+memberId) required`, `type must be PURCHASE or REFUND`, `fullName must be 4-100 chars`, `gender must be MAN or WOMEN`, `phone must be 6-20 digits, optional leading +`, `No files received in field "image"`. Plus leaks of internals: `Cannot join helpdesk network directly`, `No device registered for this member — call /auth/devices first`.

The **copy** is fixed (those messages are now Indonesian and describe the situation rather than the parameter). The **root cause is not**: these are hand-rolled validation checks in controllers instead of `validateDto`, so the responses still carry no field-level `details`, and the parameter name is now lost for debugging. Migrating them to `validateDto` is the real fix — see `docs/frontend-error-contract-migration.md` §10.2, where the FE is asked whether they want the parameter names back in `details`.

### 5. Inconsistent enumeration posture
Login is correctly generic (`Invalid credentials` for both unknown user and wrong password), but `auth.service.ts:876,894` returns `404 'Account not registered'` on forgot-password — a direct email/phone enumeration oracle. Register returns `Email/Phone/Username already registered` (common UX trade-off, but should be a conscious decision), and `email_in_use_unverified` discloses verification state.

Reflected input, JSON-only so low risk: `File extension "${ext}" is not allowed`, `Only image uploads are allowed (got "${f.mimetype}")`, `Affiliator code "${code}" not found`, and `notFoundHandler` echoing `${req.method} ${req.originalUrl}`.

### 6. ~~Internal enums and timestamps in user-visible text~~ — DONE, see "Fixed" §3

### 7. Minor — mostly resolved
- ~~40 bare `throw new UnauthorizedException()` → generic `"Unauthorized"`~~ — all now `AUTH_REQUIRED`. They remain defensive `if (!req.user)` checks on routes already behind `authGuard`, i.e. practically unreachable; removing them is a separate cleanup.
- ~~Em dash (—) in messages~~ — gone from user-facing copy; the catalog uses none.
- ~~Duplicate wording for one condition~~ — impossible now: copy is looked up by code, so one condition renders one sentence.

---

## Verified as already correct (don't "fix")

- `mapPrismaError` (`error.middleware.ts`) stops P2023/P2002/P2025 leaking as 500s containing the Prisma invocation.
- Stack traces only outside production, and only for genuinely unhandled errors.
- Rate limiter emits the standard envelope on 429 instead of express-rate-limit's plain text (its message now comes from the catalog too).
- `webhook.controller.ts` deliberately returns raw `{ received: true, … }` — provider-facing, not FE-facing.
- Login is anti-enumeration.

---

## Incidental finding: `pnpm lint` is dead repo-wide

358 errors, all `Parsing error: "parserOptions.project" has been provided` / `file was not found in any of the provided project(s)` — hitting every file, including untouched ones. Cause: `.eslintrc.cjs` sets `project: './tsconfig.json'`, but since the ADR-0001 monorepo split the root tsconfig is solution-style (`"files": []`, only `references`), so zero files belong to it.

Pre-existing, unrelated to this audit. Fixing it (point the parser at the per-package tsconfigs) will surface however many real lint errors have accumulated unseen since the split — triage that separately.
