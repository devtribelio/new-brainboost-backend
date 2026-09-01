-- Recompute `local_day` as the LISTENING day: the WIB day with a 04:00 boundary
-- instead of midnight (docs/tracker-streak.md §4). Data-only — no DDL.
--
-- Safe because `started_at` is kept in full: every historical row's day can be
-- re-derived, nothing is lost or estimated. `started_at` is a tz-less `timestamp`
-- holding UTC (app-clock convention repo-wide), hence the explicit
-- `AT TIME ZONE 'UTC'` before converting to Jakarta.
--
-- Idempotent: the WHERE skips rows already on the new boundary, so a re-run is a
-- no-op and the statement can be replayed after a partial/interrupted apply.
-- ~155k rows at time of writing; `(member_id, local_day)` index already exists.

UPDATE "listening_session"
SET "local_day" = ((("started_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Jakarta') - interval '4 hours')::date
WHERE "local_day" IS DISTINCT FROM
      ((("started_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Jakarta') - interval '4 hours')::date;
