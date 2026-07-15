/* eslint-disable no-console */
/**
 * Resync worker (long-running). Loops every RESYNC_INTERVAL_SEC, running all
 * configured syncers each tick with fresh legacy + Postgres connections (opened and
 * closed inside runResync per tick → survives legacy RDS ECONNRESET). Change cadence
 * by editing RESYNC_INTERVAL_SEC and restarting. See docs/specs/legacy-resync-plan.md §2.
 *
 *   pnpm resync:worker
 */
import { resyncConfig, selectSyncers } from './config';
import { runResync, SYNCER_ORDER } from './core';

let running = true;

async function tick() {
  const selected = selectSyncers(resyncConfig.syncers, SYNCER_ORDER);
  const ordered = SYNCER_ORDER.filter((s) => selected.includes(s));
  await runResync({ syncers: ordered, dryRun: false });
}

async function loop() {
  console.log(
    `[resync:worker] starting intervalSec=${resyncConfig.intervalSec} ` +
      `syncers=${resyncConfig.syncers} batchSize=${resyncConfig.batchSize}`,
  );
  while (running) {
    try {
      await tick();
    } catch (err) {
      console.error('[resync:worker] tick error', err);
    }
    if (!running) break;
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] [resync:worker] idle — next run in ${resyncConfig.intervalSec}s`);
    // sleep in short slices so SIGTERM is responsive
    const until = Date.now() + resyncConfig.intervalSec * 1000;
    while (running && Date.now() < until) {
      await new Promise((r) => setTimeout(r, Math.min(1000, until - Date.now())));
    }
  }
}

function shutdown(signal: string) {
  console.log(`[resync:worker] ${signal} — stopping after current tick`);
  running = false;
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

loop()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[resync:worker] fatal', err);
    process.exit(1);
  });
