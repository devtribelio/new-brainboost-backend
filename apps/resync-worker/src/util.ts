/* eslint-disable @typescript-eslint/no-explicit-any */
/** Small shared row-coercion helpers (mirror the migrate:* scripts). */

export function nonEmpty(v: any): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

export function toDate(v: any): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function bool(v: any): boolean {
  return v === 1 || v === true || v === '1';
}

/** ISO string of the larger of two date-ish values (for advancing a watermark). */
export function maxWatermark(prev: string | null, ...dates: (Date | null)[]): string | null {
  let best = prev ? new Date(prev).getTime() : Number.NEGATIVE_INFINITY;
  for (const d of dates) {
    if (d && d.getTime() > best) best = d.getTime();
  }
  return Number.isFinite(best) ? new Date(best).toISOString() : prev;
}

/** Watermark lower bound passed to legacy SQL (epoch when first run). */
export function sinceBound(since: string | null): Date {
  return since ? new Date(since) : new Date(0);
}
