/* eslint-disable no-console */
/**
 * Resync CLI (one-shot). Runs the selected syncers once and exits.
 *
 *   pnpm resync                      # all registered syncers, in dependency order
 *   pnpm resync kyc enrollments      # a subset
 *   pnpm resync --dry-run            # no writes, report counts
 *   pnpm resync kyc --since=2026-06-01T00:00:00Z   # manual watermark override
 *
 * Shares runResync() with the worker (scripts/resync/worker.ts).
 */
import { selectSyncers } from './config';
import { runResync, SYNCER_ORDER } from './core';

function parseArgs(argv: string[]) {
  const dryRun = argv.includes('--dry-run');
  const sinceArg = argv.find((a) => a.startsWith('--since='));
  const since = sinceArg ? sinceArg.slice('--since='.length) : undefined;
  const names = argv.filter((a) => !a.startsWith('--'));
  return { dryRun, since, names };
}

async function main() {
  const { dryRun, since, names } = parseArgs(process.argv.slice(2));
  const selector = names.length ? names.join(',') : 'all';
  const selected = selectSyncers(selector, SYNCER_ORDER);
  // keep dependency order regardless of CLI arg order
  const ordered = SYNCER_ORDER.filter((s) => selected.includes(s));

  const results = await runResync({ syncers: ordered, dryRun, since });

  const total = Object.values(results).reduce(
    (a, s) => ({
      scanned: a.scanned + s.scanned,
      upserted: a.upserted + s.upserted,
      skipped: a.skipped + s.skipped,
      errors: a.errors + s.errors,
    }),
    { scanned: 0, upserted: 0, skipped: 0, errors: 0 },
  );
  console.log(
    `[resync] DONE syncers=${ordered.join(',')} scanned=${total.scanned} ` +
      `upserted=${total.upserted} skipped=${total.skipped} errors=${total.errors}`,
  );
  process.exit(total.errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[resync] fatal', err);
  process.exit(1);
});
