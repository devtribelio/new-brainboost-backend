# `x-platform` header — what to send, and why it has to be exact

**Status:** backend accepts it today; production has not been verified · **Date:** 2026-09-08
**Endpoint:** `POST /api/tracking/session`
**Backend:** `apps/mobile-api/src/modules/tracker/tracking.controller.ts`
**Related:** `docs/tracker-streak.md` §3 (Aug 2026 incident)

---

## Why this exists

`listening_session.source` is the only record of **which build wrote a session row**.
It is filled from this header and from nothing else.

In August 2026 members reported "my streak broke after the update". That could not be
checked against the data, because `source` was empty for every row — the backend's
old whitelist accepted only the bare strings `ios` and `android`, and silently
discarded everything else the app was sending. The column looked like a feature
nobody had wired up. It was wired up; it was rejecting.

The backend now accepts a build suffix. Whether the app is actually sending one has
not been confirmed against production data, which is the reason for this document.

---

## What to send

```
x-platform: android/3.3.1+412
x-platform: ios/3.3.1+412
```

**Format:** `<platform>/<version>+<build>`

| Part | Rule |
|---|---|
| platform | exactly `ios` or `android` — **lowercase** |
| separator | a forward slash `/` |
| suffix | 1–32 characters of `A-Z a-z 0-9 _ . + -` |

The suffix is free-form to the backend; `<version>+<build>` is the convention we ask
for because it is what Flutter's `pubspec.yaml` already carries and what a bug report
needs. The 32-char limit is counted **after** the slash.

The header **name** is case-insensitive (HTTP). The header **value** is not.

### Accepted

| Value | Stored as |
|---|---|
| `android/3.3.1+412` | `android/3.3.1+412` |
| `ios/3.3.1+412` | `ios/3.3.1+412` |
| `ios` | `ios` |
| `android` | `android` |
| `  ios  ` | `ios` — surrounding whitespace is trimmed |

### Silently dropped → `source` is `NULL`

| Value | Why |
|---|---|
| `iOS`, `Android`, `IOS` | platform must be lowercase |
| `android 3.3.1` | space is not a valid separator |
| `android-3.3.1`, `android:3.3.1` | separator must be `/` |
| `web`, `flutter/android` | unknown platform |
| `android/` + 33 chars | suffix over the 32-char cap |
| `backfill:firebase:2026-08` | reserved — see below |
| header absent | nothing to store |

---

## ⚠️ It fails silently, by design

A malformed value does **not** produce an error. The request still answers `200`, no
warning is logged, and the session is still recorded — only `source` comes back
`NULL`.

That is deliberate: a tracking write must never fail because of a header. But it means
**you will get no feedback if the format is wrong**. That is exactly how the column sat
empty for months. If this matters to you, the only way to confirm is to query the
column after a release, not to watch for errors.

---

## Why the format is strict rather than "store whatever"

The same column carries synthetic markers written by ops scripts — `backfill:*` for
sessions recovered from Firebase, `goodwill:*` for compensation rows. If a request
header could set those, a client could disguise its own rows as recovered data, and
any audit of an incident would be reading numbers it cannot trust.

So the whitelist stays. The August failure was not that the whitelist existed; it was
that the whitelist rejected the format the app was actually sending.

---

## Flutter

```dart
final info = await PackageInfo.fromPlatform();
final platform = Platform.isIOS ? 'ios' : 'android';
final header = '$platform/${info.version}+${info.buildNumber}';
// android/3.3.1+412
```

Send it on `POST /api/tracking/session` at minimum. Sending it on every request is
harmless — no other endpoint reads it today.

Two things to guard in code rather than trust:

- **`Platform.isIOS ? 'ios' : 'android'`, never `Platform.operatingSystem`** — that
  returns `"ios"` and `"android"` today, but it is a broader enum and a value like
  `"macos"` from a desktop build would be dropped.
- **Keep the suffix under 32 characters.** `3.3.1+412` is 9. A version string with a
  long pre-release tag (`3.3.1-beta.20260908.hotfix+412`) can cross the cap and be
  dropped whole.

---

## Known caveat: a later flush overwrites the recording build

`source` sits in the update branch of the session upsert, so a re-send overwrites it.
A session recorded on build 411 and flushed from the offline queue **after** the member
upgrades to 412 is stored as `412` — the build that flushed, not the build that
recorded.

For most reporting this is noise. For "which build broke it" it is exactly backwards.
It is pinned by a test so a change is deliberate; tell us if it matters to you and we
will make `source` create-only, like `localDay` and `courseId` already are.

---

## Not in the API docs

The controller reads this header directly, so it does **not** appear in Swagger at
`/api/docs`. There is no way to discover it from the OpenAPI spec — this document is
the contract. Say the word and we will add it to the spec too.

---

## What we need from you

1. **The exact string the app sends today**, verbatim. If it is `Android/3.3.1` or
   `android 3.3.1`, it is being dropped right now and nothing is telling anyone.
2. **Which build ships the corrected header**, so we know from which date `source` can
   be trusted for version forensics.
3. Whether the "later flush wins" behaviour above needs fixing for your use.

Once a build with the header is out, we will run the column breakdown and confirm the
rows are landing — that check has never been done.
