/**
 * Asia/Jakarta (WIB) day-boundary math.
 *
 * Single-tenant, Indonesia-only product: there is no per-member timezone column,
 * so every "calendar day" and every scheduled cutoff in the system is WIB.
 * WIB is UTC+7 with no DST, so plain offset arithmetic is exact — no Intl needed.
 *
 * Canonical home for these helpers: both the listening tracker (app layer) and
 * the notification digest job (@bb/domain) need them, and a domain job may not
 * import from an app.
 */

/** WIB is UTC+7, no DST. */
export const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

/** IANA name, for anything that wants to render or configure the zone. */
export const WIB_TZ = 'Asia/Jakarta';

/**
 * Collapse an instant to its WIB calendar day.
 *
 * Returns a `Date` pinned to **UTC midnight** of that WIB day — the shape Prisma
 * stores/returns for a `@db.Date` column, so day comparisons stay plain date
 * comparisons without re-deriving the timezone.
 *
 * Example: `2026-06-23T23:30:00Z` (06:30 WIB on the 24th) → `2026-06-24`,
 * while `2026-06-23T16:30:00Z` (23:30 WIB on the 23rd) → `2026-06-23`.
 */
export function toLocalDayWIB(instant: Date): Date {
  const shifted = new Date(instant.getTime() + WIB_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

/** Stable key for a UTC-midnight day Date (e.g. `2026-06-24`). */
export function dayKey(day: Date): string {
  return day.toISOString().slice(0, 10);
}

/** Shift a UTC-midnight day Date by `n` whole days (negative = earlier). */
export function addDays(day: Date, n: number): Date {
  return new Date(day.getTime() + n * 86_400_000);
}

/**
 * The instant at which `hour` o'clock WIB occurs on the given WIB day.
 *
 * `wibDay` must be a UTC-midnight day Date (i.e. the output of `toLocalDayWIB`).
 * Example: day `2026-07-29` + hour 21 → `2026-07-29T14:00:00Z`.
 */
export function wibHourInstant(wibDay: Date, hour: number): Date {
  return new Date(wibDay.getTime() + hour * 3_600_000 - WIB_OFFSET_MS);
}
