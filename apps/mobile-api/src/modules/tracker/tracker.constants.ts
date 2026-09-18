/**
 * Listening-tracker tuning constants (spec §6/§8).
 * Kept in code (not env/DB) — these are product rules, not deployment config.
 */

/**
 * Min seconds for a session to count toward `sessionsPlayed` (lifetime) — the
 * DEFAULT, overridable at runtime via `app_settings` key `tracker.minSessionSec`
 * (`SETTING_KEYS.trackerMinSessionSec`).
 *
 * Read it through the setting, never this constant: a caller that imports the
 * constant silently ignores whatever ops set, and the two bars then disagree about
 * what counts as a session on two different screens.
 */
export const MIN_SESSION_SEC_DEFAULT = 30;

/**
 * Min total seconds listened in a single WIB day for that day to "qualify"
 * toward streak & challenge (10 minutes) — the DEFAULT, overridable at runtime via
 * `app_settings` key `tracker.qualifySec` (`SETTING_KEYS.trackerQualifySec`).
 *
 * Evaluated over the per-day SUM, not per-session — several short sessions may
 * accumulate (5+3+2 min qualifies). Gating individual sessions on this number would
 * quietly change the question to "one unbroken sitting of 10 minutes", and a member
 * who listened in three short bursts would read as 0 while their streak counted the
 * same night.
 *
 * Treat a change to it as a PRODUCT SWITCH, not a knob: it moves `streakDays`, which
 * every shipped app build already displays.
 */
export const MIN_QUALIFY_SEC_DEFAULT = 600;

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
 * Consecutive listening days a single gap may span and still be bridged by a freeze
 * — runtime-overridable via `app_settings` key `streak.graceDays`
 * (`SETTING_KEYS.streakGraceDays`), so it can be turned off without a redeploy.
 *
 * This is the WIDTH of a forgivable gap, not a window measured from today. It used
 * to be the latter, which made a freeze silently expire: a member who used one on
 * Tuesday and listened Wednesday and Thursday watched the streak stop growing,
 * because by Thursday the frozen day was too far back to cross. What limits
 * forgiveness now is `FREEZE_EARN_EVERY_DEFAULT` below — a quota, which is what the
 * window was standing in for.
 *
 * 0 disables freezes entirely and reproduces the strict walk exactly.
 */
export const GRACE_DAYS_DEFAULT = 1;

/**
 * Qualifying days inside the current streak that earn one freeze
 * (`app_settings` key `streak.freezeEarnEvery`).
 *
 * Some limit is mandatory, not a tuning preference. A streak recomputed from raw
 * rows with unlimited forgiveness means a member who listens every OTHER day has
 * every gap bridged, and "streak" degenerates into "days listened, ever". Earning
 * answers that without storing anything: the every-other-day member never reaches
 * the bar between gaps, while someone weeks into a run has clearly paid for theirs.
 *
 * The rate is the whole limit — there is deliberately no ceiling on top of it. A cap
 * would only bind on a long streak, where it would tell a member two years in that
 * their third sick day costs them everything, while the rate already requires about
 * six qualifying days per forgiven one.
 *
 * 0 disables freezes (fail-safe: a missing or malformed setting is strict, never
 * unlimited).
 */
export const FREEZE_EARN_EVERY_DEFAULT = 7;

/** Weekly recap target — qualifying days per week. */
export const WEEKLY_DAYS_TARGET = 7;
