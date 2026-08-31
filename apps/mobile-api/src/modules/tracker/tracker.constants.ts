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
 * Hour (WIB) at which the "listening day" rolls over — NOT midnight.
 *
 * Brainboost audio is played to fall asleep to: 72% of listened minutes start
 * between 21:00 and 03:59 WIB, and 12.8% of qualifying sessions cross midnight.
 * A midnight boundary therefore cuts straight through the usage peak, so a member
 * who listens every single night reads as "missed a day" purely because one night
 * started at 23:50 and the next at 00:10.
 *
 * 04:00 is the first trough in the histogram (4.3% of minutes). Everything that
 * buckets a session into a day goes through `toListeningDayWIB` — streak anchor,
 * per-program challenge, weekly recap.
 */
export const DAY_BOUNDARY_HOURS = 4;

/**
 * How far into the future `startedAt` may sit before the session is rejected.
 * The device supplies it, so a wrong phone clock lands the session on a day that
 * has not happened yet (one prod row was already dated a day ahead) and it can
 * never be part of a streak walked backward from today.
 */
export const MAX_CLOCK_SKEW_SEC = 300;

/**
 * A flush older than this is logged (not rejected) — the offline queue is meant
 * to drain within hours, so a much older `startedAt` means either a long-dead
 * device coming back or a bad clock. Rejecting would throw away real listening,
 * which is the exact failure this whole workstream exists to stop.
 */
export const STALE_FLUSH_WARN_HOURS = 24;

/**
 * Default challenge target (days), mirrored as the DB default of
 * `Course.programDays`. Spec §8.4: the "30-Day Challenge" card is just a normal
 * program challenge with target=30 — same mechanic, not a special case. The
 * per-program target now comes from `Course.programDays` (90/60/30); this stays
 * as the fallback/default reference.
 */
export const DEFAULT_CHALLENGE_TARGET = 30;

/**
 * Default number of listening days a member may miss without the streak resetting
 * to 0 — overridable at runtime via `app_settings` key `streak.graceDays`
 * (`SETTING_KEYS.streakGraceDays`), so it can be turned off without a redeploy.
 *
 * The window is measured from TODAY, not from the streak: only a gap within the
 * last `graceDays` listening days is forgiven. That is what keeps a computed-at-
 * read-time streak from silently rewriting history — without the window, every
 * single-day gap a member ever had would be forgiven the moment this ships, and a
 * streak broken months ago would come back to life.
 *
 * 0 disables grace entirely and reproduces the strict walk exactly.
 */
export const GRACE_DAYS_DEFAULT = 1;

/** Weekly recap target — qualifying days per week. */
export const WEEKLY_DAYS_TARGET = 7;
