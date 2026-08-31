# Tracker module (listening streak / sessions / total / challenge / recap)

Implements the listening-tracker backend. Spec: `docs/brainboost-tracker-spec.md`
(contract = §5, logic = §6/§8). Tasks: `docs/brainboost-tracker-tasks-backend.md`.

Two `AppModule`s share this folder (one prefix each):

| Module          | Prefix      | Route                     |
|-----------------|-------------|---------------------------|
| `TrackingModule`| `/tracking` | `POST /api/tracking/session` |
| `StatsModule`   | `/user`     | `GET  /api/user/stats/home`  |

All home metrics are derived **at read-time** from the single `ListeningSession`
log table (no pre-aggregation tables in MVP). One model, two endpoints.

## Constants (`tracker.constants.ts`)

- `MIN_SESSION_SEC = 30` — a session counts toward `sessionsPlayed` only if ≥ this.
- `MIN_QUALIFY_SEC = 600` — a WIB day "qualifies" (streak/challenge) if the day's
  **total** listened ≥ 10 min (sum across sessions, not per-session).
- `TZ = Asia/Jakarta` (UTC+7, no DST) and `DAY_BOUNDARY_HOURS = 4` — a "listening
  day" runs **04:00 → 03:59 WIB**, not midnight. Brainboost is played to fall asleep
  to, so a midnight boundary splits one night in two and reads as a missed day.
  `local_day` is stamped at write time (`toListeningDayWIB(startedAt)`) so streak
  queries stay a trivial `DISTINCT local_day`. See `docs/tracker-streak.md` §4.
- `MAX_CLOCK_SKEW_SEC = 300` / `STALE_FLUSH_WARN_HOURS = 24` — a `startedAt` in the
  future is rejected (bad device clock); one far in the past is accepted and logged
  (`tracking.stale_flush`), because that is real listening arriving late.
- `DEFAULT_CHALLENGE_TARGET = 30` — mirrors the DB default of `Course.programDays`.
  Challenge `target` comes from `Course.programDays` (90/60/30 per program); existing
  courses backfill to 30 (the "30-Day Challenge" card).

## Contract (repo envelope `{ success, data, meta, error }`)

### `POST /api/tracking/session` (auth)
Sent on pause/stop/complete/app-background. Idempotent upsert by
`(memberId, clientSessionId)`. Optional `x-platform: ios|android` header → `source`.

```jsonc
// Request body
{
  "clientSessionId": "uuid",   // generated on device at play-start
  "audioId": "uuid",           // Lesson id
  "courseId": "uuid|null",
  "startedAt": "2026-06-23T01:10:00Z",
  "listenedSec": 845,          // seconds actually heard
  "completed": true
}
// 200
{ "success": true, "data": { "ok": true }, "meta": {}, "error": null }
```

### `GET /api/user/stats/home` (auth)
```jsonc
{
  "success": true,
  "data": {
    "streakDays": 7,
    "sessionsPlayed": 23,        // lifetime, listenedSec ≥ 30
    "totalListenSec": 22500,     // lifetime
    "challenges": [
      { "courseId": "..", "code": "STOPSMOKE", "title": "Stop Smoking", "day": 7, "target": 30 }
    ],
    "weeklyRecap": {
      "weekNumber": 2,           // weeks since member join (WIB, Monday start)
      "daysActive": 6, "daysTarget": 7,
      "streakDays": 7, "listenSec": 22500
    }
  },
  "meta": {}, "error": null
}
```

## Streak rule (`tracker.streak.ts`)

Strict consecutive listening days. A day qualifies when its summed
`listenedSec ≥ 600`. Walk backward from today; if today hasn't qualified yet, start
from yesterday (not broken until the day rolls over). Any earlier gap → 0.
Per-program challenge uses the same function over sessions filtered to one
`courseId`. "Today" is `toListeningDayWIB(now)`, so at 02:00 WIB the member is still
inside yesterday's day and the streak does not look broken mid-session.

`computeStreakState` adds a grace window on top: a missed day is forgiven only while
it is within `graceDays` listening days of TODAY, so an old gap stays broken (the
streak is recomputed from raw rows on every read — a gap-relative rule would revive
the member's whole history at once). Forgiven days are returned separately and are
not counted. States: `burning` → `at_risk` → `dimmed` → `none`; `dimmed` cannot occur
at `graceDays = 0`, which reproduces the strict walk exactly.

`graceDays` is runtime-configurable via `app_settings` key `streak.graceDays`
(fallback `GRACE_DAYS_DEFAULT = 1`, seeded 1). Changing it moves the `streakDays`
every shipped app build already renders — a product switch, not a knob. The
`streak_restore` quota table (policy A) is deliberately NOT built.

## Streak reminder push (`streak-reminder.job.ts`)

Two scheduled nudges, registered in `apps/mobile-api/src/jobs-runner.ts` and gated on
the WIB hour *inside* the job (hourly `bb-cron` tick, same contract as `topicDigest`):
`streakAtRisk` in the evening, `streakDimmed` the next morning. Never sent at streak 0.

Neither label is in `PUSH_LIMIT_EXEMPT` — that list is money; a streak nudge is
engagement, and the member who forgot to listen is already past the budget. Ships
disabled (`streak.reminderEnabled = false`). Hours are settings
(`streak.atRiskHour` 21, `streak.dimmedHour` 9); **21:00 is unvalidated** — see
`docs/tracker-streak.md` §5.4.

## Tests

- `tests/tracker-time.spec.ts` — WIB calendar day, 04:00 listening-day boundary,
  week-start (unit).
- `tests/tracker-streak.spec.ts` — streak table cases (unit).
- `tests/tracker-auth.spec.ts` — 401 without token (HTTP).
- `tests/tracker.spec.ts` — service-level integration (real Postgres): idempotency,
  listening-day `local_day` (incl. the midnight-crossing case), the clock-skew
  guard, and `home()` aggregation against seeded sessions.

- `tests/tracker-streak-reminder.spec.ts` — reminder job: hour gate, state selection,
  minimum streak, dedupe, dry run (real Postgres).

Run: `pnpm test`.
