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

/**
 * Flatten a loser→winner redirect map so every entry points at the CHAIN TERMINAL.
 *
 * Redirects are normally one hop, but a manual seed or a split/merge sequence can leave
 * A→B→C; resolving a single hop would map the loser A to B, which is itself a loser with
 * no member row (so the reference would silently resolve to nobody). Walk the chain to
 * its end. A cycle (A→B→A) has no terminal, so every node on it is folded onto the
 * smallest id in the cycle — deterministic and terminating. Self-pointing entries are
 * dropped (a winner is not a loser).
 */
export function flattenRedirects(raw: ReadonlyMap<number, number>): Map<number, number> {
  const flat = new Map<number, number>();
  for (const start of raw.keys()) {
    if (flat.has(start)) continue;
    const path: number[] = [];
    const at = new Map<number, number>(); // node → index in `path`
    let current = start;
    let terminal: number;
    for (;;) {
      const seenAt = at.get(current);
      if (seenAt !== undefined) {
        terminal = Math.min(...path.slice(seenAt)); // cycle → smallest node on it
        break;
      }
      at.set(current, path.length);
      path.push(current);
      const next = raw.get(current);
      if (next === undefined) {
        terminal = current; // reached a real winner (no outgoing edge)
        break;
      }
      current = next;
    }
    for (const node of path) flat.set(node, terminal);
  }
  for (const [loser, winner] of [...flat]) if (loser === winner) flat.delete(loser);
  return flat;
}

/**
 * Folds a syncer's scanned rows into the watermark it may checkpoint:
 *
 *   checkpoint = min(maxSeen, runStart, earliestFailed − 1s)   — or null if nothing scanned
 *
 * - `seen(wm)` for every row that settled (written OR intentionally skipped — holding on a
 *   permanently unresolvable row would stall the syncer forever).
 * - `failed(wm)` for a row whose WRITE threw: the next run must re-scan it, so the
 *   checkpoint stays strictly below it (scans use `> since`).
 * - `runStart` = legacy clock captured before the syncer's first query: a row updated in an
 *   already-scanned chunk during a long run is re-scanned next tick instead of skipped.
 * - nothing scanned → null: never checkpoint (a forced `--since` must not write itself back).
 */
export class WatermarkTracker {
  private maxSeen: number | null = null;
  private minFailed: number | null = null;

  seen(wm: Date | null): void {
    if (!wm) return;
    const t = wm.getTime();
    if (this.maxSeen === null || t > this.maxSeen) this.maxSeen = t;
  }

  failed(wm: Date | null): void {
    if (!wm) return;
    this.seen(wm);
    const t = wm.getTime();
    if (this.minFailed === null || t < this.minFailed) this.minFailed = t;
  }

  result(runStart: Date): string | null {
    if (this.maxSeen === null) return null;
    let cp = Math.min(this.maxSeen, runStart.getTime());
    if (this.minFailed !== null) cp = Math.min(cp, this.minFailed - 1000);
    return new Date(cp).toISOString();
  }
}

/** Loggable tag for a row-write error — the code only: Prisma messages can echo row data (PII). */
export function errCode(err: unknown): string {
  const e = err as { code?: string; name?: string } | null;
  return e?.code ?? e?.name ?? 'unknown';
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
