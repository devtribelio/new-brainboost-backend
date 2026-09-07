# Streak calendar — backend response to the API contract request

**Status:** implemented and merged · **Date:** 2026-09-04
**Branch:** `feat/batch-juli-jalur-a` · commits `5e47db3`, `4434bc3`
**Answers:** `streak-calendar-contract.md` (mobile, `feat/streak-states-weekly-strip`)
**Related:** `docs/tracker-streak.md` §5 (streak states, grace, 04:00 boundary)

The endpoint is built to the shape you proposed, field for field. Four things
differ from the proposal, one of which makes an example in your document
unreachable — read **Where this differs** before wiring the states up.

There is also a behaviour change on `GET /user/stats/home`, which you already
consume. It needs no client release, but it will change what some members see.

---

## Endpoint

```
GET /api/user/stats/streak/calendar?month=YYYY-MM
```

Bearer auth. `month` is optional; omitted means the month `today` falls in.
Wrapped in the standard `{ success, data, meta, error }` envelope.

### Response (`data`)

```jsonc
{
  "month": "2026-09",
  "today": "2026-09-04",
  "days": [
    { "date": "2026-09-01", "state": "burning" },
    { "date": "2026-09-02", "state": "none"    },
    { "date": "2026-09-03", "state": "dimmed"  },
    { "date": "2026-09-04", "state": "at_risk" }
  ],
  "qualifiedDays": 12,
  "longestRun": 6,
  "currentStreak": 12,
  "earliestMonth": "2026-03",
  "qualifyThresholdSec": 600,
  "dayBoundaryHour": 4
}
```

| Field | Type | Notes |
|---|---|---|
| `month` | `string` | Echoes the month this page covers, `YYYY-MM` |
| `today` | `string` | The **listening** day, server-computed. Never derive it from the device clock |
| `days[].date` | `string` | Listening day, `YYYY-MM-DD` |
| `days[].state` | `string` | `burning` · `at_risk` · `dimmed` · `none`. **Never `future`** |
| `qualifiedDays` | `int` | Days in this month with state `burning` |
| `longestRun` | `int` | Longest qualifying run **inside this month** — see below |
| `currentStreak` | `int` | Identical to `streakDays` on `/user/stats/home` |
| `earliestMonth` | `string \| null` | First month with any listening history. `null` = never listened |
| `qualifyThresholdSec` | `int` | Currently `600` |
| `dayBoundaryHour` | `int` | Currently `4` |

The last five describe the **member**, not the page, and are returned on every
response including one for a month long past — as you asked. A March response
carries `earliestMonth` so the pager never strands.

### Errors

| Case | Status | Code |
|---|---|---|
| No / invalid bearer token | `401` | `BEARER_TOKEN_MISSING` |
| Malformed `month` | `400` | `VALIDATION_ERROR` |
| Month with no history | `200` | `days: []` |
| Future month | `200` | `days: []` |
| Member who has never listened | `200` | `days: []`, `earliestMonth: null` |

Rejected as malformed: `2026-13`, `2026-00`, `2026-9`, `2026-09-01`, `sept`.
A well-formed month outside the member's history (`2019-02`) is a normal `200`.

---

## Rules as implemented

**Only days the member could have listened on appear.** Nothing before their
first tracked day, nothing after `today`. One rule covers both ends, which is
why `future` is never emitted — draw an omitted date as a plain number, as you
planned.

**`days` is contiguous.** Dates are only ever dropped at the two ends of the
month, never in the middle, so you can walk the array as calendar-adjacent.

**Dates are listening days.** The 04:00 WIB boundary applies here exactly as it
does to `weeklyStreak`: a session started 01:00 on the 5th belongs to the 4th.

**At most one `at_risk`**, always `today`, only in the month containing `today`.
It carries no claim about streak length — a member on zero still gets it. It
means "today is still open", not "your streak is about to break".

**States come from the same code as `weeklyStreak`.** Both surfaces call one
`dayState()` helper, so a day in the dialog and the number on the tile cannot
disagree by construction.

---

## Where this differs from your proposal

### 1. `dimmed` cannot appear where your example puts it

Your sample response has `2026-09-02` as `dimmed` with `today` = `2026-09-04`.
That is not reachable, and not because of a gap in the implementation.

Grace is anchored on **today**, not on the gap. A missed day is forgiven only
while it sits within `graceDays` listening days of today; anything older ends
the walk. That anchor is load-bearing: the streak is recomputed from raw
sessions on every read and nothing is stored, so a gap-relative rule would
revive **every** single-day gap in the member's entire history the moment grace
shipped — a streak broken in May would come back as 90 days.

What this means for the calendar:

- `dimmed` appears only on the day **immediately before `today`**.
- A month in the past therefore contains **no** `dimmed` cells, ever.
- One exception: when `today` is the 1st, the frozen day falls on the **last day
  of the previous month**, so that month shows exactly one `dimmed` cell.
- `graceDays` is runtime-configurable (`app_settings` → `streak.graceDays`,
  currently `1`). At `N`, up to `N` consecutive frozen days can sit immediately
  before today. **Do not hardcode 1** — read the shape from the response.

Please correct the example in your document. Everything else about `dimmed`
works as you described.

Related, and worth knowing because it explains an oddity you may already have
seen: on a Monday the headline can report `state: "dimmed"` with a live
`restoreDeadline` while `weeklyStreak` contains no `dimmed` cell at all — the
frozen day is in the previous week, outside the seven-day window. The monthly
calendar fixes this, since it shows the day the strip cannot.

### 2. `longestRun` bridges a frozen day, and is clipped to the month

A `dimmed` day does **not** break the run, and is **not** counted toward it —
the same treatment the streak walk gives it. Without that, the two numbers in
one dialog could contradict each other.

It is still clipped at month edges, as you specified. A run spanning
28 Aug → 3 Sep reports `4` in August and `3` in September. So `longestRun` is
routinely **smaller than `currentStreak`**, which is correct but reads badly
under a bare "Streak terpanjang" label. Recommend the copy says "bulan ini",
or tell us and we will return an unclipped figure instead.

### 3. `earliestMonth` comes from the first **tracked** day

Not the first *qualifying* day. A member whose first ever session was five
minutes has that day returned as `none` rather than omitted — it is still a day
they could have listened on, and hiding it would make the calendar start on a
date the member does not recognise.

### 4. A malformed `month` is a `400`

Your document did not specify. Well-formed but out-of-range months stay `200`
with an empty list, per your rules; only an unparseable value is an error.

---

## Behaviour change on `GET /user/stats/home`

Shipped in the same branch (`5e47db3`). **No response shape change, no client
release needed** — but the output moves for some members.

`weeklyStreak` now emits **fewer** `dimmed` days. A frozen day used to be
reported whenever the gap fell inside the grace window, before the walk had
shown the streak actually survived it. When the walk broke on the next day, the
gap was still reported as forgiven — so the strip drew a frozen day over a
streak that was already dead, and a member who had **never listened at all**
got one on yesterday.

A frozen day is now only reported when it genuinely bridges two qualifying
days. Concretely, with `graceDays = 1` and `today` = Fri:

Mon→Fri shown; Sat and Sun are `future` in every row.

| Member | `streakDays` | Thursday cell before | after |
|---|---|---|---|
| Burning Mon+Tue, missed Wed **and** Thu, nothing today | `0` | `dimmed` | **`none`** |
| Has never listened | `0` | `dimmed` | **`none`** |
| Listened today only | `1` | `dimmed` | **`none`** |
| Burning Mon–Wed, missed Thu, nothing today | `3` | `dimmed` | `dimmed` (unchanged) |
| Burning Mon–Wed, missed Thu, listened today | `4` | `dimmed` | `dimmed` (unchanged) |

The first three are the bug: a frozen day sat next to a streak of zero, or next
to no history at all. The last two are a real bridge and are untouched.

`streakDays`, `streak.state`, `restoreDeadline` and every other field are
unchanged for every input. Only which cells are frozen moves.

---

## Your request pattern — no objection

You asked whether the call pattern is expensive. It is not.

One indexed `groupBy` on `(member_id, local_day)` answers every field in the
response. Scoping it to the requested month would not be cheaper —
`currentStreak` and `earliestMonth` need the whole history anyway, so a month
filter buys a second query rather than a smaller one. A member with two years
of listening is roughly 700 rows.

Your ~3–4 requests per app open (warm + two neighbours + the revalidation on
open) is fine as designed. Ship it.

**No cache headers are set.** If you would rather the warm request be
cacheable, say so and we will add `Cache-Control: private, max-age=60`.

---

## Your two known gaps, answered

**Does `days` for the current month include today?** Yes. Today is always
present while it is within the member's tracked range — `at_risk` until it
qualifies, `burning` after. The qualified branch wins over the today branch, so
listening never flips the cell backwards.

**A member with no history at all?** `earliestMonth: null`, `days: []`,
`currentStreak: 0`, `qualifiedDays: 0`, `longestRun: 0`, and `today` /
`qualifyThresholdSec` / `dayBoundaryHour` still populated — exactly what you
said the client expects.

---

## Not built

- **Per-day listening minutes.** As you scoped it: the calendar answers "did
  this day count", not "by how much".
- **A range endpoint.** Not needed, agreed.
- **`weeklyStreak` removal from `/user/stats/home`.** Untouched, as you asked.
- **Cache headers.** See above.
- **A per-course calendar.** `courseStats` still returns only the seven-day
  strip. Tell us if the per-program card needs the monthly view too.

---

## What we need from you

1. Confirm the three calls above: `longestRun` semantics, `400` on a malformed
   `month`, `earliestMonth` from the first tracked day.
2. Correct the `dimmed` example in your contract document.
3. Decide the "Streak terpanjang" copy — with or without "bulan ini".
