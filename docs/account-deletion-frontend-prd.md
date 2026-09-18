# PRD — Account deletion: the grace window is visible and cancellable (mobile)

**Status:** ready for implementation · **Date:** 2026-09-18
**Backend:** implemented on `feat/account-soft-delete` (branched from `feat/batch-juli-jalur-a`)
**Client:** `brainboost-apps`
**Related:** `docs/account-deletion.md` (backend spec)

---

## Problem Statement

The app already has a delete-account flow. It has never been cancellable.

`verificationDeleteAccount` schedules the deletion, deactivates the account and revokes
every refresh token. After that, every door is shut: the access token the app still holds
answers `SESSION_REVOKED`, password login answers `INVALID_CREDENTIALS`, and both social
paths answer `MEMBER_INACTIVE`. `recoverAccountScheduled` needs a bearer token, and there
was no way left to obtain one.

So the grace period existed only on paper. A member who deleted their account by mistake —
or changed their mind an hour later — had no route back at all, and nothing on screen ever
told them a grace period was supposed to exist.

Two further gaps sit on top of that:

1. **Nothing names the deadline.** The profile payload carries `isDeleted: 1`, which says
   a deletion is pending but not when it lands. There is nothing to render a warning with.
2. **Nothing says what happens to the money.** An affiliate with an unwithdrawn commission
   balance deletes their account and the balance becomes unreachable without a support
   ticket. They are told none of this. It bites hardest on the members who *cannot* cash
   out first: the payout minimum is 15,000 and KYC must be approved.

## Solution

Backend now lets a member log back in during the window. Logging in reopens the account
but **deliberately does not cancel the deletion** — the deadline survives, and cancelling
is an explicit action.

That split is the core of this PRD, and it is not an implementation detail. If login
silently cancelled, a member who opens the app out of habit, or taps "Continue with
Google" once, would call off a deletion they meant to happen — and would never find out,
because nothing would be shown and no email would be sent. A deletion that quietly does
not happen is the exact failure this feature exists to prevent.

So the app carries the other half: **a persistent banner that states the date and offers
one tap to cancel.** Without it, the member logs in, sees a normal app, assumes the
deletion was called off, and is deleted 30 days later.

## User Stories

**As a member who deleted my account by mistake,** I want to log back in and be told
plainly that my account is still scheduled for deletion, with the date, so I can stop it.

**As a member who meant to delete my account,** I want logging in once not to silently
undo it — if I do nothing, it should still go through.

**As an affiliate with an unwithdrawn balance,** I want to be told before I confirm that
my commission will become unreachable, so the decision is an informed one.

**As a member past the deadline,** I want a clear message that the window has closed and a
route to support, not a generic error.

## Implementation Decisions

### 1. The banner is the only new surface

Where it lives: every screen the member lands on after login, not just the profile tab.
A member who deletes their account and comes back is not necessarily going to profile. A
top-of-screen banner on home is the minimum; an additional one on profile is fine.

It is **persistent, not a toast**. It has to survive navigation and app restarts, because
the condition survives them. Dismissing it is acceptable only for the current session —
never permanently, and never persisted.

Copy (Indonesian, the app's language):

> **Akun kamu dijadwalkan dihapus**
> Semua data kamu akan dihapus permanen pada **18 Oktober 2026**.
> [ Batalkan penghapusan ]

Render the date from the API value, never from a locally computed "today + 30". The window
length is server-configurable (`app_settings` → `account.deletionGraceDays`) and can change
without an app release.

**Do not hardcode "30 hari" in any copy.** If ops changes the setting, static copy starts
lying while the banner's own date stays correct. Either omit the day count or derive it
from the date.

### 2. Reading the state

`GET /api/member/account/profile/info` — two fields matter:

| Field | Type | Meaning |
|---|---|---|
| `isDeleted` | `0 \| 1` | Existing. `1` = a deletion is pending |
| `scheduledDeletionAt` | ISO 8601 string \| `null` | **New.** The deadline |

`scheduledDeletionAt` is additive — a client that predates it keeps working, and every
other field is unchanged.

Show the banner when `scheduledDeletionAt != null`. Prefer it over `isDeleted` as the
trigger: they always agree, but only one of them can be rendered.

### 3. Cancelling

```
POST /api/member/account/recoverAccountScheduled
Authorization: Bearer <access_token>
```

**No request body.** No DTO, no query params — the member is identified by the token.
Anything sent is ignored.

Success `200`:
```json
{ "success": true, "data": { "memberId": "<uuid>", "recovered": true }, "meta": null, "error": null }
```

On success: hide the banner and refetch the profile. Do not assume the new state — re-read
it, so the app and the server cannot drift.

Failure `400 DELETION_NOT_SCHEDULED` covers three cases that are deliberately
indistinguishable: nothing was scheduled, the deadline passed, or the purge already ran.
They mean the same thing to the app — **there is nothing left to cancel** — so handle them
as one:

> Masa pembatalan sudah lewat. Hubungi customer service untuk bantuan.

Then clear the banner and refetch.

### 4. Login behaves normally, with one thing added

`POST /api/member/oauth/token` is unchanged in shape. The only difference is that a member
inside the grace window now gets `200` where they previously got `401`. No new error codes,
no field changes, no migration on the client.

The work is purely what happens *after* a successful login: fetch the profile as usual, and
if `scheduledDeletionAt` is set, show the banner. If this step is skipped the feature is
worse than not shipping it, because the member now has a working app and a false belief.

`grant_type=refresh_token` is unaffected — the tokens were revoked at scheduling, so that
path is never reached. The member must log in with credentials, which is intended.

### 5. Balance warning on the confirmation screen

**Blocked on backend.** `requestDeleteAccount` does not currently return the member's
balance, so the figure is not available. Tracked in `docs/account-deletion.md` §8.

When it ships, the confirmation screen should carry the amount before the member commits:

> Kamu punya saldo komisi **Rp 250.000** yang belum dicairkan. Setelah akun dihapus, saldo
> ini tidak bisa diakses tanpa bantuan customer service.

Design the confirmation screen so this line can be added without a rework — the copy above
the confirm button should not be a fixed-height block.

## Testing Decisions

Backend has integration coverage for the state machine (`account-soft-delete.spec.ts`,
8 cases). The client cases worth covering:

1. Log in as a member inside the window → banner renders with the correct date.
2. Log in, kill the app, reopen → banner still renders. It is not session state.
3. Tap cancel → `200` → banner disappears and stays gone after a refetch.
4. Tap cancel on an expired window → `400` → support message, banner cleared.
5. Log in and navigate around without tapping cancel → banner survives navigation.
6. A member with no scheduled deletion → no banner, no extra request.

Manual check worth doing once: schedule a deletion, log back in, confirm the deletion
still lands on the original date. The most likely regression is an implementation that
treats login as cancellation.

## Out of Scope

- **Notifications.** No email when the deletion is scheduled, no reminder before the
  deadline, no confirmation after. Not built on either side.
- **Restoring a purged account.** Past the deadline this is a support operation run from
  backoffice, and it is re-onboarding rather than an undelete — the member sets a new
  password and re-does KYC. No app surface.
- **Re-registration after deletion.** The email is freed, so the member can sign up again,
  but that creates a *new* account: the old purchases, courses and balance stay on the old
  row and are not reachable. No special handling in the app — it is an ordinary register.
  Worth briefing support, who will get asked about it.
- **Account merge** when someone re-registers and then asks for their old balance back.

## Further Notes

**Why the member can use the app normally during the window.** Once logged in, the account
is fully functional — they can buy, listen, post. This is deliberate: the account still
exists, and crippling it would punish someone who may be about to cancel. The banner is the
only thing that marks the state.

**What "deleted" actually means,** if support or copy needs to explain it: personal data is
destroyed permanently (name, email, phone, photos, address, bank details, KYC documents),
while purchase history, course progress and commission records are kept — they are
financial records, and the affiliate tree above the member depends on the row continuing to
exist. The honest one-line version is *"your personal data is permanently deleted; your
balance and purchase history can be reclaimed through support."*
