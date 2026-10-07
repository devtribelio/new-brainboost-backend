/* eslint-disable no-console */
/**
 * Resync CLI (one-shot). Runs the selected syncers once and exits.
 *
 *   pnpm resync                      # all registered syncers, in dependency order
 *   pnpm resync kyc enrollments      # a subset
 *   pnpm resync --dry-run            # no writes, report counts
 *   pnpm resync kyc --since=2026-06-01T00:00:00Z   # manual watermark override
 *   pnpm resync enrollments --dry-run --audit-csv=out.csv   # CSV journal of every decision
 *
 * `--audit-csv` is opt-in and one-shot only (the periodic worker never sets it): it writes a
 * row per decision (cancel/create/repoint/skip + before/after) so a repair run can be reviewed
 * beforehand and traced back if something was cancelled or granted wrongly.
 *
 * Shares runResync() with the worker (scripts/resync/worker.ts).
 */
import { selectSyncers } from './config';
import { runResync, SYNCER_ORDER } from './core';

function parseArgs(argv: string[]) {
  const dryRun = argv.includes('--dry-run');
  const sinceArg = argv.find((a) => a.startsWith('--since='));
  const since = sinceArg ? sinceArg.slice('--since='.length) : undefined;
  // Opt-in CSV journal of row-level decisions (review + trace-back). One-shot runs only —
  // the periodic worker never passes it. Bare flag → a default file name per syncer.
  const auditArg = argv.find((a) => a === '--audit-csv' || a.startsWith('--audit-csv='));
  const auditCsv = auditArg
    ? auditArg.includes('=')
      ? auditArg.slice('--audit-csv='.length)
      : ''
    : undefined;
  const names = argv.filter((a) => !a.startsWith('--'));
  return { dryRun, since, names, auditCsv };
}

async function main() {
  const { dryRun, since, names, auditCsv } = parseArgs(process.argv.slice(2));
  const selector = names.length ? names.join(',') : 'all';
  const selected = selectSyncers(selector, SYNCER_ORDER);
  // keep dependency order regardless of CLI arg order
  const ordered = SYNCER_ORDER.filter((s) => selected.includes(s));

  const results = await runResync({ syncers: ordered, dryRun, since, auditCsv });

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
