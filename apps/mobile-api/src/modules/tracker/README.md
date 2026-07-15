# Tracker module (listening streak / sessions / total / challenge / recap)

Implements the listening-tracker backend. Spec: `docs/specs/brainboost-tracker-spec.md`
(contract = §5, logic = §6/§8). Tasks: `docs/specs/brainboost-tracker-tasks-backend.md`.

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
- `TZ = Asia/Jakarta` (UTC+7, no DST). Day boundary is WIB; `local_day` is stamped
  at write time so streak queries are a trivial `DISTINCT local_day`.
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

Strict consecutive WIB days. A day qualifies when its summed `listenedSec ≥ 600`.
Walk backward from today; if today hasn't qualified yet, start from yesterday (not
broken until the day rolls over). Any earlier gap → 0. Per-program challenge uses
the same function over sessions filtered to one `courseId`.

## Tests

- `tests/tracker-time.spec.ts` — WIB day boundary + week-start (unit).
- `tests/tracker-streak.spec.ts` — streak table cases (unit).
- `tests/tracker-auth.spec.ts` — 401 without token (HTTP).
- `tests/tracker.spec.ts` — service-level integration (real Postgres): idempotency,
  WIB `local_day`, and `home()` aggregation against seeded sessions.

Run: `pnpm test`.
