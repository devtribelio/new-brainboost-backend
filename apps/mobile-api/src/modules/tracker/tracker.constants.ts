/**
 * Listening-tracker tuning constants (spec §6/§8).
 * Kept in code (not env/DB) — these are product rules, not deployment config.
 */

/** Min seconds for a session to count toward `sessionsPlayed` (lifetime). */
export const MIN_SESSION_SEC = 30;

/**
 * Min total seconds listened in a single WIB day for that day to "qualify"
 * toward streak & challenge (10 minutes). Evaluated over the per-day SUM,
 * not per-session — several short sessions may accumulate.
 */
export const MIN_QUALIFY_SEC = 600;

/** Day-boundary timezone. Indonesia (WIB) is UTC+7 with no DST. */
export const TZ = 'Asia/Jakarta';
export const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * Default challenge target (days), mirrored as the DB default of
 * `Course.programDays`. Spec §8.4: the "30-Day Challenge" card is just a normal
 * program challenge with target=30 — same mechanic, not a special case. The
 * per-program target now comes from `Course.programDays` (90/60/30); this stays
 * as the fallback/default reference.
 */
export const DEFAULT_CHALLENGE_TARGET = 30;

/** Weekly recap target — qualifying days per week. */
export const WEEKLY_DAYS_TARGET = 7;
