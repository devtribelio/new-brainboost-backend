import { DAY_BOUNDARY_HOURS, WIB_OFFSET_MS } from './tracker.constants';

/**
 * Collapse an instant to its Asia/Jakarta (WIB, UTC+7) calendar day.
 *
 * Returns a `Date` pinned to **UTC midnight** of that WIB day — the shape
 * Prisma stores/returns for a `@db.Date` column, so streak/recap queries can
 * compare days as plain dates without re-deriving the timezone.
 *
 * Example: `2026-06-23T23:30:00Z` (06:30 WIB on the 24th) → `2026-06-24`,
 * while `2026-06-23T16:30:00Z` (23:30 WIB on the 23rd) → `2026-06-23`.
 */
export function toLocalDayWIB(instant: Date): Date {
  const shifted = new Date(instant.getTime() + WIB_OFFSET_MS);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()),
  );
}

/**
 * Collapse an instant to its **listening day** — the WIB day whose boundary is
 * `DAY_BOUNDARY_HOURS` (04:00), not midnight. This is the day a session is
 * credited to, and the anchor "today" is measured from.
 *
 * Shifting the instant back by the boundary and then taking the plain WIB day is
 * all it takes: listening day D spans `[D 04:00 WIB, D+1 04:00 WIB)`.
 *
 * Example: `2026-08-27T23:59` WIB → day 27; `2026-08-28T00:30` WIB → **still**
 * day 27; `2026-08-28T04:10` WIB → day 28.
 *
 * A session is credited whole to the day it STARTED on — never split. Combined
 * with the 04:00 boundary that already covers the 23:59→00:30 case, and splitting
 * would only matter for a >4h session straddling 04:00.
 *
 * Use `toLocalDayWIB` only for things that are genuinely calendar dates (a signup
 * date, a week anchor), never for bucketing listening.
 */
export function toListeningDayWIB(instant: Date): Date {
  return toLocalDayWIB(new Date(instant.getTime() - DAY_BOUNDARY_HOURS * 3_600_000));
}

/** Stable key for a UTC-midnight day Date (e.g. `2026-06-24`). */
export function dayKey(day: Date): string {
  return day.toISOString().slice(0, 10);
}

/** Calendar-month key for a UTC-midnight day Date (e.g. `2026-06`). */
export function monthKey(day: Date): string {
  return dayKey(day).slice(0, 7);
}

/**
 * First and last day of a `YYYY-MM` month, as UTC-midnight day Dates.
 *
 * `Date.UTC(y, m, 0)` is day zero of the FOLLOWING month, i.e. the last day of this
 * one — which is how February and the 30/31-day split are handled without a table.
 * The shape is validated at the route edge, so this trusts it.
 */
export function monthBounds(month: string): { start: Date; end: Date } {
  const [y, m] = month.split('-').map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 0)) };
}

/** Shift a UTC-midnight day Date by `n` whole days (negative = earlier). */
export function addDays(day: Date, n: number): Date {
  return new Date(day.getTime() + n * 86_400_000);
}

/**
 * The instant a listening day closes, as an ISO string with the WIB offset
 * (e.g. `2026-08-29T03:59:59+07:00` for listening day 2026-08-28).
 *
 * Inclusive end — one second before the boundary — because it is shown to the
 * member as a deadline ("sampai jam 04.00"), not used for comparison.
 */
export function listeningDayEndsAt(day: Date): string {
  const hh = String(DAY_BOUNDARY_HOURS - 1).padStart(2, '0');
  return `${dayKey(addDays(day, 1))}T${hh}:59:59+07:00`;
}

/**
 * Monday (WIB) of the week containing `day` (a UTC-midnight WIB day).
 * Used as the anchor for weekly-recap windows and week numbering.
 */
export function weekStartMondayWIB(day: Date): Date {
  // getUTCDay(): 0=Sun..6=Sat. Days to subtract to reach Monday.
  const dow = day.getUTCDay();
  const back = (dow + 6) % 7;
  return addDays(day, -back);
}
