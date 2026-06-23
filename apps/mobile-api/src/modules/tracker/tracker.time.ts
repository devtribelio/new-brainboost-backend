import { WIB_OFFSET_MS } from './tracker.constants';

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

/** Stable key for a UTC-midnight day Date (e.g. `2026-06-24`). */
export function dayKey(day: Date): string {
  return day.toISOString().slice(0, 10);
}

/** Shift a UTC-midnight day Date by `n` whole days (negative = earlier). */
export function addDays(day: Date, n: number): Date {
  return new Date(day.getTime() + n * 86_400_000);
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
