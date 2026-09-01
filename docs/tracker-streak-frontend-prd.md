# PRD — Streak states and the weekly strip (mobile)

**Status:** ready for implementation · **Date:** 2026-08-31
**Backend:** implemented on `feat/batch-juli-jalur-a` (hotfix + BB-112 + BB-114 merged)
**Client:** `brainboost-apps`
**Related:** `docs/tracker-streak.md` (backend spec), `docs/brainboost-tracker-spec.md` (original tracker spec)

---

## Problem Statement

A member who listens to Brainboost every single night can open the app and find their
streak reset to zero.

Brainboost audio is played to fall asleep to. 72 % of listened minutes start between
21:00 and 03:59 WIB, the histogram peaks at 23:00, and 12.8 % of qualifying sessions
cross midnight. The app used to close its "day" at midnight, so one continuous habit —
put the audio on, fall asleep — was recorded as two different days whenever the member
started at 23:50 one night and 00:10 the next. The night in between looked empty, and
the streak broke.

Measured on production: 10,676 broken days in 30 days under the midnight rule. Three
members escalated it as a support complaint; one of them had a genuine 6-day run
recorded as broken.

Two further problems sit on top of that:

1. **The number is the whole story.** Today the home screen shows a single figure.
   A member who misses one night goes from `12` to `0` with no warning beforehand, no
   indication it is about to happen, and no way back. Every comparable product
   (TikTok, Snapchat, Duolingo) puts at least one state between "on" and "gone".

2. **The weekly strip and the streak number can disagree.** The strip added in BB-112
   buckets days by calendar midnight while the streak now buckets by the listening day.
   After the backend change ships, a member can see `streakDays: 12` next to a Monday
   square that is empty — because the session they started at 01:00 Monday belongs to
   Sunday night.

---

## Solution

The home screen shows a streak that behaves like a habit, not a counter.

**A flame with four states.** Lit and orange while today already counts. Lit but marked
"not safe yet" once the evening comes and the member has not listened. Grey but *still
showing the number* on the morning after a missed night, with a clear way to bring it
back before the day closes. Grey and empty only once the chance is gone.

**A weekly strip that agrees with the number.** Seven circles, Monday to Sunday, drawn
with the *same* flame vocabulary as the headline streak — lit, at risk, dimmed, out, or
not yet. The dimmed circle is what makes the grey flame legible: the member can see
exactly which night was let off.

**A day that ends at 04:00, not midnight.** The strip, the streak, and any copy about
deadlines all use the same boundary, and the app never derives "today" from the device
clock.

Nothing about this requires the member to learn a new rule to benefit from it: the
number simply stops breaking for reasons they did not cause.

---

## User Stories

### Seeing the streak

1. As a member who listened tonight, I want the flame lit and my streak number shown, so that I know tonight already counted.
2. As a member who has not listened yet today, I want the flame to stay lit with my current number, so that I do not think the streak is already lost.
3. As a member who has not listened yet today, I want a visible "not safe yet" marker, so that I know the night is not finished.
4. As a member who missed last night, I want to still see my streak number in grey rather than a zero, so that I know it is recoverable.
5. As a member with a grey streak, I want to see how long I have left to bring it back, so that I can decide whether to listen now.
6. As a member with a grey streak, I want an explicit action that tells me what to do ("listen 10 minutes"), so that I do not have to guess the rule.
7. As a member with no streak, I want a neutral empty state rather than a zero shouted at me, so that starting again does not feel like a punishment.
8. As a member, I want the streak number to be the same everywhere it appears on the home screen, so that I never see two different figures.

### The weekly strip

9. As a member, I want to see seven circles for the current week, so that I can see my pattern at a glance.
10. As a member, I want each day I qualified to show a lit flame, so that I can count my week without doing arithmetic.
11. As a member, I want a day I missed to be visibly different from a day that has not happened yet, so that Thursday's empty circle does not read as a failure on Tuesday.
12. As a member whose missed day was forgiven, I want that circle dimmed rather than lit or crossed out, so that the grey headline flame and the strip tell the same story.
13. As a member, I want today's circle marked as still open while I have not listened yet, so that it reads as an invitation rather than a failure.
14. As a member who listened at 01:00 on Monday, I want that to light Sunday's circle, so that the strip matches how the streak counted it.
15. As a member, I want the strip to use the server's idea of today rather than my phone's clock, so that a wrong device time does not misdraw my week.

### Understanding the rules

16. As a member, I want to know that the listening day ends at 04:00, so that listening at 01:00 does not feel like it is too late.
17. As a member, I want to know how many minutes count as a day, so that I know when I am done.
18. As a member, I want the threshold to come from the server, so that the app does not tell me 10 minutes while the backend wants something else.
19. As a member confused by the grey flame, I want an explanation available (tooltip or sheet), so that I do not assume it is a bug.

### Notifications

20. As a member with a streak at risk, I want an evening reminder, so that I can act before the day closes.
21. As a member whose streak went grey, I want a morning reminder that it can still be revived, so that I get a second chance.
22. As a member with no streak, I want no reminder at all, so that the app does not nag me about something I have already lost.
23. As a member tapping a streak notification, I want to land on the home screen, so that I can act immediately.

### Resilience

24. As a member on an old app build, I want the streak number to keep working, so that I am not forced to update to see it.
25. As a member, I want the app to render sensibly if the server sends a state it does not recognise, so that a backend change never blanks my home screen.
26. As a member with no listening history, I want the home screen to render without errors, so that day one is not broken.

---

## Implementation Decisions

### API contract — `GET /api/user/stats/home`

Everything below is **additive**. The existing `streakDays`, `sessionsPlayed`,
`totalListenSec`, `challenges` and `weeklyRecap` fields are unchanged, so a build that
predates this work keeps working with no server-side branching.

From BB-112:

```jsonc
"today": "2026-08-31",
"qualifyThresholdSec": 600
```

From `hotfix/listening-session-streak`:

```jsonc
"streak": {
  "days": 12,
  "state": "burning" | "at_risk" | "dimmed" | "none",
  "restoreDeadline": "2026-09-01T03:59:59+07:00",   // null unless state === "dimmed"
  "dayBoundaryHour": 4
}
```

And the strip — **implemented**; each entry carries a `state` drawn from the same
vocabulary as the headline streak:

```jsonc
"weeklyStreak": [
  { "date": "2026-08-25", "state": "burning" },
  { "date": "2026-08-26", "state": "dimmed"  },
  { "date": "2026-08-27", "state": "none"    },
  { "date": "2026-08-28", "state": "at_risk" },   // today, not qualified yet
  { "date": "2026-08-29", "state": "future"  },
  ...
]
```

`qualified: boolean` from BB-112 is **replaced**, not kept alongside. That commit has not
reached `main`, so no shipped build reads it and there is nothing to stay compatible
with. Two booleans could also encode a state that has no meaning (`qualified` and
`forgiven` both true); one enum cannot.

The same strip is returned by the per-course stats endpoint (BB-114), which now also
reads the grace setting — without it that screen and `challenges[].day` would report two
different numbers for the same course.

### One state vocabulary, used in two places

The headline streak and every circle in the strip speak the same language. The client
writes one `state → presentation` function and calls it five times for the strip and once
for the headline.

| `state` | Headline meaning | Per-day meaning | Presentation |
|---|---|---|---|
| `burning` | Today's listening day already qualifies | That day qualified | Flame lit, orange |
| `at_risk` | Today has not qualified yet; yesterday did | **Today**, not qualified yet | Open / outlined, inviting |
| `dimmed` | The flame is out but the streak survived it — revivable until the day closes | The flame was out that day, and grace let it pass | Flame grey |
| `none` | No flame at all | That day was missed and not forgiven | Crossed out / empty, muted |
| `future` | *never sent* | That day has not happened yet | Faint placeholder |

Reading `dimmed` as **"the flame is out but the streak survived it"** is what makes one
word work in both places: for today it means revivable, for a past day it means it was
let off. Same idea, different tense.

Two invariants worth stating because the type cannot enforce them:

- The headline `state` is **never** `future`. The strip is the only place that value appears.
- At most **one** entry in the strip is `at_risk`, and it is always today's. A past day is
  never at risk.

`state` is a **string**, not an enum ordinal. An unrecognised value must fall back to the
`burning` presentation rather than crash or blank — new states may be added later, and
they will land in both places at once.

### `days` and `streakDays` are the same value

Both are produced from one computation. The client may read either. They are asserted
equal by a backend test, so they cannot drift. Prefer `streak.days` in new code and
treat root `streakDays` as the compatibility field.

### `restoreDeadline`

Emitted **only** while `dimmed`; `null` in every other state. It is an ISO 8601 string
with the WIB offset (`2026-09-01T03:59:59+07:00`). Do not render a countdown when it is
null — the other states have nothing to count down to.

### The day boundary is 04:00, and it is not the client's to decide

`dayBoundaryHour` is returned so copy such as "hari dengar berganti jam 04.00" is not
hardcoded. The client must not compute day boundaries itself: use `today` from the
response for "which square is today", and `weeklyStreak[].date` for the rest. A device
clock that is wrong, or a member in a different timezone, must not change the drawing.

### Backend change required: `weeklyStreak` must move to the listening day

This is not just a new field. `buildWeeklyStreak()` and `today` currently bucket by
calendar midnight (`toLocalDayWIB`). After the boundary change they must use the
listening-day function, or the strip will contradict the streak number next to it — a
session started 01:00 Monday fills Sunday for the streak and Monday for the strip.

Two of the three concrete changes were already carried by the merge, because both
`buildWeeklyStreak()` and `today` read the same `todayWIB` variable the streak anchor
uses, and that variable had already moved to the listening day:

1. ~~`buildWeeklyStreak()` buckets by listening day~~ — done by the merge.
2. ~~`today` is the current listening day~~ — done by the merge.
3. Each entry's `qualified: boolean` replaced by `state`, derived server-side from the
   day's total, the grace walk's `forgivenDays`, and the day's position relative to
   `today`. **This was the only change that had to be written.**

Deriving `future` on the server rather than in the client is deliberate: the client would
have to compare dates to decide it, and client-side date arithmetic against a device clock
is the exact class of bug this whole workstream exists to remove.

### The client derives nothing

Each entry arrives with its `state` already decided. The client reads it and draws. It
does not compare dates, does not consult the device clock, and does not infer "missed"
from an absent flag.

The one distinction that must survive into the design is `none` vs `future`: an empty
Thursday circle on a Tuesday is not a failure. If both render as a plain empty circle the
strip reads as five failures every Monday.

**Design consequence worth flagging.** The current UI draws a missed day as a red ✗. Once
grace ships, some of those days become `dimmed` instead. Red therefore has to mean *lost*
rather than merely *skipped* — if every non-qualifying day stays red, grace is invisible
and the feature has no effect the member can see.

### Grace is a server-side product switch

Grace is configured on the server (`streak.graceDays`, shipping at 1) and can be turned
off without a client release. The client must therefore not assume a `dimmed` state will
ever appear — with grace at 0 it never occurs, in the headline or in the strip. Both
presentations must degrade cleanly to the four remaining values.

### Notifications

Two push types, both new, both frozen once shipped:

| `type` | When | Copy |
|---|---|---|
| `streakAtRisk` | Evening, streak ≥ 3, has not listened tonight | **Streak {N} hari belum aman** / Dengarkan 10 menit malam ini untuk menjaganya. |
| `streakDimmed` | Next morning, grace still carrying the streak | **Streak {N} hari kamu padam** / Dengarkan 10 menit malam ini untuk menyalakannya lagi. |

Nothing is ever sent at streak 0. Both ship disabled and are enabled server-side. An
unrecognised `type` already falls back to the default icon, so no client release is
required for the pushes to arrive — but the client should route a tap on either to the
home screen. Send times are server-configurable and will move.

### Merge order

Both branches modify the same files (`stats.service.ts`, `stats-home.dto.ts`,
`tracking.service.ts`, `tracking.controller.ts`). Git resolves the textual overlap; the
three semantic items above are invisible to it and must be applied by hand during the
merge, whichever branch lands second.

---

## Testing Decisions

A good test here asserts what a member would see, not how it was computed. Assert the
rendered state of the flame and each square given a response payload — never the
internals of a date helper, and never a hardcoded "today", which makes the suite fail
overnight.

**Client — one `state → presentation` function, tested directly.** Because the headline
and the strip share a vocabulary, the mapping is one unit and deserves a table test over
all five values plus an unknown string. This is the deepest testable seam in the client
work: it has a tiny interface, no I/O, and it is where a wrong colour or a crash on an
unrecognised value would come from.

**Client — headline widget tests, one per state.** Feed a fixture payload, assert whether
the number renders and whether a countdown renders. Include: `none` hides the number;
`dimmed` shows it in grey with a countdown; `at_risk` shows the "belum aman" marker; an
unknown `state` falls back rather than throwing.

**Client — strip tests.** Seven circles from a fixture, covering: `dimmed` renders
distinctly from both `burning` and `none`; `future` is visually distinct from `none`;
`at_risk` appears on exactly one circle; and a member with no history renders an empty
week without error.

**Client — clock independence.** Run the strip tests with the device clock set to a
different day and timezone; output must not change. This is the regression guard for the
whole class of bug this PRD exists to fix.

**Backend — the new field.** Extend the existing stats integration test (real Postgres,
per `docs/tracker-streak.md`): a member with a grace-forgiven day gets exactly one entry
with `state: "dimmed"`; days after today are `future`; the headline `state` is never
`future`; and at most one entry is `at_risk`. Prior art:
`apps/mobile-api/tests/tracker.spec.ts` already asserts the streak block against seeded
sessions; `tracker-streak.spec.ts` covers the grace walk as a table test.

**Backend — the disagreement guard.** Assert that a session started at 01:00 lights the
previous day's strip entry *and* counts toward the streak — one test that would have
caught the contradiction this PRD is correcting.

---

## Out of Scope

- **Restore quota.** No "2 restores left" counter and no `streak_restore` table. The
  grace window is anchored on today, which is what the quota was load-bearing for.
  `restoresLeft` is not in the response; do not build UI for it.
- **Per-program challenge cards.** `challenges[].day` currently returns 0 for every
  member because of a backend ID mismatch (`docs/tracker-streak.md` §8b, BUG-1). Out of
  scope here; the cards should be treated as unreliable until that is fixed.
- **Recovering listening the app never sent.** A separate backfill path exists on the
  backend and is unlikely to run; no client work.
- **A mute or preference toggle for streak notifications.** Not built. The only control
  today is the OS notification setting.
- **Changing the qualifying threshold or the 04:00 boundary.** Both are server-side.
- **`weeklyRecap` reading 0/7 on a Monday morning** while the streak is double digits.
  Correct by the rule (`docs/tracker-streak.md` §8b, BUG-2); a copy or layout decision,
  not an API change.

---

## Further Notes

**The number will move on the day this deploys.** Measured across 10,516 members active
in the last 90 days: 1,244 streaks get longer (5,733 days recovered in total; 544 members
go from zero to a live streak) and 434 get shorter. The shortening is a correction, not a
regression — the midnight rule counted a single night as two days whenever a member
listened at 23:00 and again at 01:00 — but 84 members lose five days or more, the largest
going from 37 to 9. Support should have an answer ready before this ships.

**No client release gates any of this.** Every field is additive and the root
`streakDays` is unchanged, so shipped builds keep working through the backend deploy. The
client work can land whenever it is ready.

**The evening send time is not yet validated.** Only 8.5 % of listened minutes start at
21:00 while the peak is 23:00, so at send time most of the night's listeners have not
started. The hour is server-configurable and expected to move; do not build anything that
assumes it.
