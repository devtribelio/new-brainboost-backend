# App Version Check — Draft API Contract (3.2.3 patch)

Contract draft from the mobile side for moving the force/soft update config off
Supabase and onto our own backend. Today the app scrapes the store listing
(`new_version_plus`) and reads the Supabase table `mobile_version_config`; both
gates go away and this endpoint becomes the single source of truth for the
update verdict. Written to be iterated with backend; open questions at the end.

- **Owner (FE):** mobile app — Lionnarta.
- **Status:** ACCEPTED + IMPLEMENTED on BE (2026-08-03) — contract unchanged from
  the draft. See "BE answers" and §2 at the end.
- **Ships in:** 3.2.3 patch (`stage` branch). The app fails open, so the
  endpoint can land on staging first and prod before the 3.2.3 release.
- **Replaces:** Supabase `mobile_version_config` (FE deletes the Supabase
  dependency wholesale in the same patch).

## Shared conventions (existing, unchanged)

- Envelope: `BaseResponse<T>` — `{ "success": bool, "data": T, "meta": {...}, "error": { "code", "message" } }`.
- The path below is the FULL path including `/api` (the client base URL
  carries `/api`, so the app-side relative path is `app/version-check`).
- Errors follow the unified error contract (`error.code` catalog,
  display-ready Indonesian `error.message`).

---

## §1 Version verdict — `GET /api/app/version-check`

Request:

```
GET /api/app/version-check?platform=android&version=3.2.3&build=186
```

- `platform`: enum `android | ios`. Required.
- `version`: semver string from the installed bundle (`PackageInfo.version`).
  Required. **The verdict is computed from this field.**
- `build`: int (`versionCode` / iOS build number). Required, but telemetry /
  tie-break only — do not compute the verdict from it in v1.
- No `env` param: stage and prod are separate BE deployments, env is implicit.

Response `data`:

```jsonc
{
  "update": "force",         // "none" | "soft" | "force" — the verdict, BE is sole source of truth
  "latestVersion": "3.3.0",  // informational: what BE considers current for this platform
  "storeUrl": null,          // nullable; app v1 IGNORES it (native store_redirect client-side) — future-proofing
  "message": null            // nullable; when set, overrides the update-dialog body copy (Indonesian)
}
```

Semantics / client behavior:

- `update: "force"` → blocking, non-dismissible dialog; the only action opens
  the store listing. `"soft"` → dismissible dialog, shown once per cold start.
  `"none"` → nothing.
- **Unknown/future `update` values are treated as `"none"`** by the client
  (forward-compatible; BE may add verdicts later without breaking old builds).
- `message` is used verbatim as the dialog body for both variants when
  non-null; titles and buttons stay client-side. No em dashes in copy.
- Fail-open: any non-2xx, non-`success` envelope, timeout (client caps the
  call at 5s) or parse error → the app silently skips the check for that
  session. No retry, no error UI.
- **Auth: public endpoint.** The client interceptor auto-attaches a bearer
  when a token exists, so the endpoint must accept: no token, a valid token,
  and an **expired** token. It must never answer `401` — a version ping must
  not be able to trigger a token refresh / forced logout.
- Caching: `Cache-Control: no-store` recommended (called once per cold start
  and per login, tiny payload). BE may cache the config internally.

Suggested BE storage (BE's call, out of app scope): per-platform row
`{ forceBelow, latestVersion, storeUrl?, message? }`, verdict computed as
`version < forceBelow → force`, else `version < latestVersion → soft`, else
`none` (semver comparison, not string compare).

Ops runbook notes (consequence of dropping the store-scrape gate):

- Flip `force` for a version **only after** the store listing actually serves
  the newer build (Play staged rollout / App Store propagation), otherwise
  users are trapped on a dialog pointing at a store that has nothing newer.
  Prefer soft → force escalation.
- The force threshold must stay **below** the iOS version currently in Apple
  review, or the reviewer meets a non-dismissible dialog → rejection.

**Open questions for BE**

1. Path scope: is `app/...` fine as a new top-level segment, or should this
   live under an existing prefix (e.g. `member/data/app-version`)? FE has no
   preference beyond it being public.
2. Confirm the verdict is computed from semver `version` only, with `build`
   just logged (v1). If BE would rather compare on `build` (monotonic int,
   simpler), FE can follow — but then `latestVersion` should gain a
   `latestBuild` sibling.
3. Confirm expired-bearer tolerance (never `401`) — see Auth note above.
4. Is `message` a single string per platform row, or does BE want it
   per-verdict (`softMessage` / `forceMessage`)? FE v1 renders one body copy
   either way.
5. Confirm `storeUrl` may stay `null` in v1 (client uses the native store
   redirect with hardcoded package id / App Store id).

**BE answers (2026-08-03)**

Implemented as specified — the contract above is accepted unchanged, no field
renamed or dropped. Answers in order:

1. **Path: `GET /api/app/version-check` as drafted.** New top-level module
   `app-version` with prefix `/app` (`apps/mobile-api/src/modules/app-version/`).
   Not put under `member/...` — that prefix is the authenticated member surface,
   and this is public.
2. **Verdict from semver `version` only, confirmed.** `build` is accepted,
   logged on the `app.version_check` line next to the verdict, and never used in
   the computation. No `latestBuild` in v1. `build` is **optional** rather than
   required: rejecting a request over a telemetry-only field could only ever
   cost us the check.
3. **Expired-bearer tolerance confirmed.** The route has no `authGuard` at all
   (guards are opt-in per route here), so no token, a valid token, an expired
   one and a malformed one all return `200`. There is no code path that can
   produce a `401`. Covered by tests.
4. **`message`: stored per verdict in the DB (`soft_message` / `force_message`),
   returned as the single `message` field.** Ops can word the blocking dialog
   differently from the nag without any FE change. Null = the client falls back
   to its own copy.
5. **`storeUrl` stays `null` in v1, confirmed.** The column exists so it can be
   filled later without an app release.

Extra behaviour worth knowing on the FE side:

- **Unparseable `version` → `none`, not `400`.** A malformed version string from
  some old build must never be able to trap a user behind a force dialog.
  Two-segment (`3.2`) and suffixed (`3.3.0-beta.1`) versions are accepted and
  compared on the release triple.
- **Unknown `platform` → `400`** (`VALIDATION_ERROR`). Only `android` / `ios`.
- **Both comparisons are strict `<`.** A client sitting exactly on a threshold
  is not nagged.
- **Missing config row → `none`** with `latestVersion: null`. Staging without
  seed data is silent, not broken.
- `Cache-Control: no-store` is sent.

## §2 BE implementation notes (ops)

Storage is one row per platform in `app_version_configs`:

| column | meaning |
|---|---|
| `platform` | `android` / `ios`, primary key |
| `latest_version` | semver; the **soft** threshold, also returned as `latestVersion` |
| `force_below` | semver or `NULL`; the **force** threshold. `NULL` = force disabled |
| `store_url` | optional override, `NULL` in v1 |
| `soft_message` / `force_message` | dialog body per verdict; `NULL` = client default copy |

Verdict: `version < force_below → force`, else `version < latest_version →
soft`, else `none`. Numeric per-segment compare, so `3.10.0 > 3.9.9`.

Separate rows per platform is load-bearing: Play staged rollout and App Store
review do not land together, so `latest_version` legitimately diverges, and the
iOS force threshold has a constraint Android does not (must stay below the build
in Apple review).

Editing (no redeploy — config is cached ~60s, so a change lands within a minute):

```sql
-- release: soft first
UPDATE app_version_configs
   SET latest_version = '3.3.0', soft_message = 'Versi baru sudah tersedia. Yuk update.'
 WHERE platform = 'android';

-- later, ONLY once the store actually serves the newer build
UPDATE app_version_configs
   SET force_below = '3.3.0', force_message = 'Update wajib untuk melanjutkan.'
 WHERE platform = 'android';

-- kill-switch
UPDATE app_version_configs SET force_below = NULL WHERE platform = 'android';
```

Because this endpoint replaces the store-scrape gate, the table is the only thing
between a typo and a fleet-wide lockout. DB `CHECK` constraints are the guardrail:
`platform IN ('android','ios')`, both version columns must match
`^[0-9]+\.[0-9]+\.[0-9]+$` (rejects `v3.3.0`, `3.3`, trailing space), and
`force_below <= latest_version` compared as `int[]` (real semver ordering).

Bootstrap: `pnpm seed:app-version` — insert-only, seeds both platforms with
`force_below = NULL`. Re-running never overwrites a live threshold.

A backoffice-bb UI for these rows is a separate follow-up; until then ops edits
by SQL. Whatever form gets built should require an explicit confirmation step on
`force_below` specifically.
