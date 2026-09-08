# Course stats — `streak` replaced by `daysListened`

**Status:** implemented, not yet deployed · **Date:** 2026-09-07
**Branch:** `feat/batch-juli-jalur-a` · commits `a363c56`, `4d0be62`, `495e8a5`
**Endpoint:** `GET /api/user/stats/course/{courseId}`
**Related:** `docs/tracker-streak.md` §8b–8d, `docs/streak-calendar-contract.md`

**This is a breaking change**, and it arrives together with a bug fix that will make
the numbers on this screen move for every member at once. Read *Numbers you have
never seen* before you ship against it.

---

## What changed

```diff
  {
    "courseId": "019f7ea6-71dd-…",
-   "streak": 12,
+   "daysListened": 12,
    "weeklyStreak": [ … ],
    "totalListenSec": 45600,
    "lastListenedAt": "2026-07-22T14:14:00.000Z"
  }
```

`streak` is **gone**. A client reading it now gets `undefined`.

Everything else in the payload is unchanged, including `weeklyStreak`.

---

## What `daysListened` means

**How many days this member really listened to this course.** Not a streak, not a
count of plays.

A day counts when the member's audio **for this course** summed to at least
`tracker.qualifySec` (currently 600s / 10 minutes) within one listening day.

Four rules, all of which the old `streak` also followed:

**Cumulative across the day, not one unbroken sitting.** 5 + 3 + 2 minutes counts.
This matters more than it sounds: Brainboost audio is played to fall asleep to, so
broken-up listening is the normal case, not the exception.

**A day runs 04:00 → 03:59 WIB, not midnight.** A session started at 23:50 and one
at 00:10 land on the **same** day. Same boundary the streak and the calendar use.

**Only this course.** Audio from other courses does not contribute.

**Lifetime, not windowed.** Every qualifying day the member has ever had on this
course, not just this month.

---

## Three things it is NOT — please check your copy

**Not consecutive.** `daysListened: 12` means twelve days total, which may be
scattered across six months. Copy like *"12 hari berturut-turut"* would be wrong.
Something closer to *"Kamu sudah mendengarkan course ini 12 hari"* is accurate.

**Not the same as the streak, and it can be 0 while the flame burns.** A member who
listens 5 minutes to course A and 5 minutes to course B qualifies for the **global**
streak — 10 minutes total — while `daysListened` is `0` for **both** courses. Correct
by the rule, but the two numbers sit on different screens and will look inconsistent
to a member who compares them.

**Not implied by `totalListenSec`.** `totalListenSec` is raw seconds, ungated. A
course can show `totalListenSec: 400` with `daysListened: 0` — listened to, but never
enough in a day to count. Do not derive one from the other.

---

## ⚠️ Numbers you have never seen in production

`streak` on this endpoint has been returning **`0` for every member since the feature
shipped**, and so has `challenges[].day` on `/stats/home`. The cause was a stored id
mismatch (`docs/tracker-streak.md` §8b): the client sends a product id in a field
named `courseId`, and the join looked for a course id, so it never matched for
anybody.

That is fixed in the same branch. So on deploy:

- `daysListened` shows a **real, often large** number where `streak` always showed 0;
- `challenges[].day` on `/stats/home` starts showing real progress too, with no client
  change at all.

If any screen was built around "this is always 0" — hidden, collapsed, or a
placeholder — it will start rendering. Worth a look before release.

---

## ⚠️ Open: this endpoint does not tell you the threshold

`tracker.qualifySec` is now **runtime-configurable** (`app_settings`, default 600).
Ops can change it without a redeploy, and it moves what counts as a day here.

`/stats/home` and `/stats/streak/calendar` both return `qualifyThresholdSec` so the
copy can follow the rule. **This endpoint does not.** If the course screen renders
"Dengarkan 10 menit untuk menghitung hari" from a hardcoded constant, that copy goes
stale silently the moment the setting changes.

Tell us if you want `qualifyThresholdSec` added here — it is additive,
non-breaking, and free (the value is already loaded to compute `daysListened`).

---

## Unchanged

- **`weeklyStreak`** — still exactly 7 entries, Monday→Sunday of the current WIB
  week, same `burning` / `at_risk` / `dimmed` / `none` / `future` vocabulary. Removing
  it was not asked for and is a much larger break.
- **`totalListenSec`**, **`lastListenedAt`**, **`courseId`** — untouched.
- **`challenges[].day`** on `/stats/home` is still a per-course **streak**. If product
  wants that replaced too, say so — it is a separate decision, not something we
  changed by implication.
- A never-listened course is still a `200` with zeros and `lastListenedAt: null`,
  never a `404`.

---

## Not included

- **How many *people* listened to this course.** A course-level popularity number was
  discussed and is not in this change. It is a different shape of query — every index
  on `listening_session` leads with `member_id`, so counting across members needs a
  new index and a migration. Ask and we will scope it properly.
- **Number of plays.** `daysListened` counts days, not sessions. A per-course play
  count is cheap to add if you want it alongside.
- **Per-day minutes.** This answers "did the day count", not "by how much".

---

## Deploy order

1. **Backend first** is safe for `weeklyStreak` and `challenges[].day` — no client
   change needed for those.
2. **`daysListened` needs the client release**, since `streak` disappears. A build
   that reads `streak` will render `undefined` rather than a number.

Tell us which release train this lands in and we will hold or ship accordingly.

---

## What we need from you

1. Confirm the copy on this screen does not say "berturut-turut".
2. Decide whether `qualifyThresholdSec` should be returned here.
3. Tell us if a play count or a listener count is also wanted, so we scope them once
   rather than twice.
