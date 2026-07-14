/* eslint-disable @typescript-eslint/no-explicit-any */
/** Small shared row-coercion helpers (mirror the migrate:* scripts). */
import { resyncConfig } from './config';

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

/**
 * Watermark lower bound passed to legacy SQL (epoch when first run). A stored watermark
 * is pulled back by RESYNC_WATERMARK_LAG_SEC: legacy `updated` is assigned at PHP save()
 * time but the row only becomes visible at COMMIT, so a row can surface AFTER our scan
 * already passed its second. Re-scanning the lag window is free — every write is
 * idempotent (upsert / guarded update / createMany skipDuplicates).
 */
export function sinceBound(since: string | null): Date {
  return since ? new Date(new Date(since).getTime() - resyncConfig.watermarkLagSec * 1000) : new Date(0);
}

/**
 * Run `fn` over `items` with at most `limit` in flight (worker-pool, no chunk barrier).
 * `fn` MUST handle its own errors (per-row try/catch) — a rejection here aborts the pool.
 * With limit<=1 behaves exactly like the old sequential loop.
 */
export async function runConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  if (limit <= 1) {
    for (let i = 0; i < items.length; i += 1) await fn(items[i], i);
    return;
  }
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}
