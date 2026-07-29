// Time + naming helpers for the monthly affiliate leaderboard (§11 / BB-121).
// Calendar months are WIB (UTC+7), consistent with the rest of the app.

const WIB_OFFSET_MS = 7 * 3_600_000;

export interface Period {
  year: number;
  month: number; // 1..12
}

/**
 * Sentinel "period" holding the all-time ranking in the same table as the
 * monthly ones. `0/0` can never collide with a real WIB month, so the lifetime
 * board reuses the unique index, the rank column and the whole read path — a
 * member's all-time rank stays a single indexed lookup, exactly like a month.
 */
export const LIFETIME_PERIOD: Period = { year: 0, month: 0 };

export function isLifetime(p: Period): boolean {
  return p.year === LIFETIME_PERIOD.year && p.month === LIFETIME_PERIOD.month;
}

/** The WIB calendar period (year, month 1..12) that `instant` falls in. */
export function wibPeriodOf(instant: Date): Period {
  const wib = new Date(instant.getTime() + WIB_OFFSET_MS);
  return { year: wib.getUTCFullYear(), month: wib.getUTCMonth() + 1 };
}

/** UTC instant of WIB 00:00 on the 1st of `period` (the month's inclusive start). */
export function wibMonthStartUtc(period: Period): Date {
  return new Date(Date.UTC(period.year, period.month - 1, 1) - WIB_OFFSET_MS);
}

export function nextPeriod(p: Period): Period {
  return p.month === 12 ? { year: p.year + 1, month: 1 } : { year: p.year, month: p.month + 1 };
}

export function prevPeriod(p: Period): Period {
  return p.month === 1 ? { year: p.year - 1, month: 12 } : { year: p.year, month: p.month - 1 };
}

/** A period is frozen once `freezeDays` have passed since its WIB month end. */
export function isPeriodFrozen(p: Period, now: Date, freezeDays: number): boolean {
  const monthEndUtc = wibMonthStartUtc(nextPeriod(p));
  return now.getTime() >= monthEndUtc.getTime() + freezeDays * 86_400_000;
}

/** True if `p` is later than the WIB period `now` sits in. */
export function isPeriodFuture(p: Period, now: Date): boolean {
  const cur = wibPeriodOf(now);
  return p.year > cur.year || (p.year === cur.year && p.month > cur.month);
}

/**
 * Deterministic display name for other affiliates on the leaderboard: first 3
 * chars of the first name + `*`, plus the last name's initial. "Budi Santoso"
 * → "Bud* S.". Pure function of the stored name, so a row never renames between
 * refreshes. Only the caller's own row uses the uncensored name.
 */
export function censorAffiliateName(fullName: string | null | undefined): string {
  const name = (fullName ?? '').trim().replace(/\s+/g, ' ');
  if (!name) return 'Brainboost User';
  const parts = name.split(' ');
  const firstMasked = `${parts[0].slice(0, 3)}*`;
  if (parts.length === 1) return firstMasked;
  const lastInitial = parts[parts.length - 1].charAt(0).toUpperCase();
  return `${firstMasked} ${lastInitial}.`;
}
