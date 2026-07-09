/**
 * Resync configuration — single declaration point for every RESYNC_* env var.
 * Kept separate from packages/common `env` (which uses required() for the app and
 * would throw when a bare `tsx scripts/...` process lacks the full app env).
 */
import 'dotenv/config';

function num(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

export const resyncConfig = {
  /** Worker loop interval (seconds). Change + restart to re-pace. */
  intervalSec: num('RESYNC_INTERVAL_SEC', 3600),
  /** Which syncers the worker runs: "all" or a CSV subset. */
  syncers: (process.env.RESYNC_SYNCERS ?? 'all').trim(),
  /** Rows per fetch/upsert batch. */
  batchSize: num('RESYNC_BATCH_SIZE', 1000),
  /**
   * Max Postgres writes in flight per syncer. The write loops are RTT-bound on a remote
   * DB; N concurrent independent row-writes cut wall-clock ~N×. Keep <= the Prisma pool
   * size (default num_cpus*2+1) or writes just queue on the pool.
   */
  writeConcurrency: num('RESYNC_WRITE_CONCURRENCY', 10),
  /**
   * Seconds subtracted from a stored watermark on the next run (overlap re-scan).
   * Covers boundary-second races and legacy rows whose `updated` predates their COMMIT.
   */
  watermarkLagSec: num('RESYNC_WATERMARK_LAG_SEC', 60),
  /** Reconnect attempts on a legacy ECONNRESET within a single run. */
  legacyReconnectRetries: num('RESYNC_LEGACY_RECONNECT_RETRIES', 3),
  /**
   * Run-lock TTL (seconds). A run holds a DB lock row; if a process dies the lock
   * auto-expires after this so the next tick can proceed. Default 2× interval.
   */
  get lockTtlSec(): number {
    return num('RESYNC_LOCK_TTL_SEC', this.intervalSec * 2);
  },
};

/** Resolve the "all" / CSV selector against the registered syncer names. */
export function selectSyncers(selector: string, all: string[]): string[] {
  const s = selector.trim();
  if (s === '' || s === 'all') return all;
  const want = s.split(',').map((x) => x.trim()).filter(Boolean);
  const unknown = want.filter((w) => !all.includes(w));
  if (unknown.length) throw new Error(`unknown syncer(s): ${unknown.join(', ')} (known: ${all.join(', ')})`);
  return want;
}
