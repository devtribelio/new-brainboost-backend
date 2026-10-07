/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * Resync engine: acquires a TTL run-lock, builds the shared context (redirect map +
 * member id map), then runs the requested syncers in dependency order, persisting a
 * per-syncer watermark (checkpointed per batch) and last-run stats to `sync_state`.
 *
 * See docs/legacy-resync-plan.md. Uses a dedicated PrismaClient + console logging to
 * match the migrate:* script runtime (plain `tsx scripts/...`, no app env required).
 */
import os from 'node:os';
import { PrismaClient } from '@prisma/client';
import { connectResilientLegacy, legacyNow } from './legacy-db';
import { resyncConfig } from './config';
import { registry, SYNCER_ORDER } from './syncers';
import { makeEnsureMember } from './ensure-member';
import { backfillNewMembers } from './backfill-new-members';
import { recountCounters } from './recount';
import { emptyStats, type RunCtx, type Stats, type SyncerCtx } from './types';
import { errCode, flattenRedirects, skipReasonsSummary } from './util';
import { auditPathFor, ChangeLog } from './change-log';

const LOCK_ROW = '__lock__';

function ts() {
  return new Date().toISOString().slice(11, 19);
}
function log(msg: string) {
  console.log(`[${ts()}] [resync] ${msg}`);
}

export interface RunOpts {
  syncers: string[]; // resolved syncer names to run (ordered by caller)
  dryRun: boolean;
  since?: string | null; // manual watermark override (applies to all selected syncers)
  /**
   * One-shot only (`pnpm resync <syncer> --audit-csv=…`): write a CSV journal of the row-level
   * decisions (cancel/create/repoint/…) so the run can be reviewed and traced back. Empty string
   * → a default per-syncer file name. The periodic worker never passes it.
   */
  auditCsv?: string | null;
}

/** Acquire the DB run-lock. Returns the owned acquiredAt, or null if held elsewhere. */
export async function acquireLock(prisma: PrismaClient): Promise<Date | null> {
  await prisma.syncState.createMany({ data: [{ syncer: LOCK_ROW }], skipDuplicates: true });
  const now = new Date();
  const cutoff = new Date(now.getTime() - resyncConfig.lockTtlSec * 1000);
  const res = await prisma.syncState.updateMany({
    where: { syncer: LOCK_ROW, OR: [{ lastRunAt: null }, { lastRunAt: { lt: cutoff } }] },
    data: { lastRunAt: now, lastStats: { host: os.hostname(), pid: process.pid } },
  });
  return res.count === 1 ? now : null;
}

export async function releaseLock(prisma: PrismaClient, acquiredAt: Date): Promise<void> {
  // Only clear if we still own it (TTL takeover could have reassigned it).
  await prisma.syncState.updateMany({
    where: { syncer: LOCK_ROW, lastRunAt: acquiredAt },
    data: { lastRunAt: null },
  });
}

/**
 * Refresh the lock's lastRunAt so a run longer than the TTL isn't taken over mid-write
 * (the first full run exceeded the default 2h TTL). Returns the new stamp while we still
 * own the lock, or null when another process took it — the caller must stop writing.
 */
async function heartbeatLock(prisma: PrismaClient, ownedAt: Date): Promise<Date | null> {
  const now = new Date();
  const res = await prisma.syncState.updateMany({
    where: { syncer: LOCK_ROW, lastRunAt: ownedAt },
    data: { lastRunAt: now },
  });
  return res.count === 1 ? now : null;
}

async function buildCtx(prisma: PrismaClient, legacy: any, dryRun: boolean): Promise<RunCtx> {
  const rawRedirect = new Map<number, number>();
  for (const r of await prisma.memberRedirect.findMany({ select: { loserLegacyId: true, winnerLegacyId: true } })) {
    rawRedirect.set(r.loserLegacyId, r.winnerLegacyId);
  }
  // Flatten A→B→C so a loser that was itself redirected resolves to the terminal winner,
  // not to an intermediate loser that has no member row.
  const redirect = flattenRedirects(rawRedirect);
  const memberByLegacy = new Map<number, string>();
  for (const m of await prisma.member.findMany({ where: { legacyId: { not: null } }, select: { id: true, legacyId: true } })) {
    if (m.legacyId !== null) memberByLegacy.set(m.legacyId, m.id);
  }
  log(`ctx: redirect=${redirect.size} members=${memberByLegacy.size}`);

  const resolveMember = (legacyId: number | null | undefined): string | undefined => {
    if (legacyId === null || legacyId === undefined) return undefined;
    const winner = redirect.get(legacyId) ?? legacyId;
    return memberByLegacy.get(winner);
  };
  // Real runs create new in-scope members on demand; dry runs never write, so ensureMember
  // degrades to a pure lookup (new members simply resolve to undefined → row skipped).
  const ensureMember = dryRun
    ? async (legacyId: number | null | undefined) => resolveMember(legacyId)
    : makeEnsureMember({ prisma, legacy, redirect, memberByLegacy, log });

  return {
    prisma,
    legacy,
    redirect,
    memberByLegacy,
    resolveMember,
    ensureMember,
    batchSize: resyncConfig.batchSize,
    dryRun,
    log,
  };
}

/** Run one resync pass for the given syncers. Safe to call repeatedly (worker loop). */
export async function runResync(opts: RunOpts): Promise<Record<string, Stats>> {
  const prisma = new PrismaClient({ log: ['warn', 'error'] });
  const results: Record<string, Stats> = {};
  const runStarted = Date.now();
  const startedAt = new Date();
  const runId = startedAt.toISOString();
  let acquired: Date | null = null;
  try {
    acquired = await acquireLock(prisma);
    if (!acquired) {
      log('another resync run holds the lock — skipping this tick');
      return results;
    }

    // Serialize run-lock heartbeats: the periodic timer and each syncer's checkpoint share
    // this, so two refreshes can't race on the same stamp (the loser would read a stale
    // lastRunAt and falsely report the lock lost). Returns false once we no longer own it.
    let heartbeatInFlight: Promise<boolean> | null = null;
    const heartbeat = (): Promise<boolean> => {
      if (!acquired) return Promise.resolve(false);
      if (!heartbeatInFlight) {
        const stamp = acquired;
        heartbeatInFlight = heartbeatLock(prisma, stamp)
          .then((next) => {
            if (next) acquired = next;
            return next !== null;
          })
          .finally(() => {
            heartbeatInFlight = null;
          });
      }
      return heartbeatInFlight;
    };
    // Refresh well inside the TTL: a syncer that runs longer than lockTtlSec (the first
    // members/posts pass can) must not be taken over mid-write because its only checkpoint
    // is at the end.
    const heartbeatMs = Math.max(30_000, Math.floor((resyncConfig.lockTtlSec * 1000) / 3));
    const legacy = await connectResilientLegacy(
      { dateStrings: false },
      resyncConfig.legacyReconnectRetries,
      log,
    );
    log(
      `connected to legacy mariadb${opts.dryRun ? ' (DRY RUN)' : ''} ` +
        `(reconnect retries=${resyncConfig.legacyReconnectRetries})`,
    );
    try {
      const ctx = await buildCtx(prisma, legacy, opts.dryRun);

      for (const name of opts.syncers) {
        const syncer = registry[name];
        if (!syncer) {
          log(`WARN: unknown syncer "${name}" — skipping`);
          continue;
        }
        const state = await prisma.syncState.findUnique({ where: { syncer: name } });
        const stored = state?.watermark ?? null;
        const since = opts.since !== undefined ? opts.since : stored;
        // a --since NEWER than the stored watermark leaves (stored, since] unscanned: this run
        // may move the watermark back (a held failure) but never forward across that gap
        const gapFloor =
          opts.since && stored && new Date(opts.since) > new Date(stored) ? new Date(stored) : null;
        // a --since OLDER than the stored watermark is a repair pass over rows already behind it:
        // a failure there must not rewind the stored watermark (the next tick would re-scan from
        // that point) — it is logged, and the operator re-runs the repair
        const repairFloor =
          opts.since && stored && new Date(opts.since) < new Date(stored) ? new Date(stored) : null;
        const syncerLog = (m: string) => console.log(`[${ts()}] [resync:${name}] ${m}`);

        // opt-in row-level journal (one-shot runs only) — see change-log.ts
        const changeLog = opts.auditCsv
          ? new ChangeLog(auditPathFor(opts.auditCsv, name, startedAt), name, runId, opts.dryRun)
          : undefined;
        if (changeLog) syncerLog(`change-log → ${changeLog.path}`);

        const syncerCtx: SyncerCtx = {
          ...ctx,
          changeLog,
          log: syncerLog,
          since,
          // captured BEFORE the syncer's first data query — the checkpoint ceiling
          runStart: await legacyNow(legacy),
          async checkpoint(watermark: string | null) {
            if (opts.dryRun || !watermark) return;
            if (gapFloor && new Date(watermark) > gapFloor) {
              syncerLog(`--since is past the stored watermark ${stored} — not advancing it to ${watermark}`);
              return;
            }
            if (repairFloor && new Date(watermark) < repairFloor) {
              syncerLog(`repair pass held below the stored watermark ${stored} — keeping it, not rewinding to ${watermark}`);
              return;
            }
            // refresh the run-lock first: a long run must not be taken over mid-syncer, and
            // a lost lock means another process owns sync_state now → stop, don't write
            if (!(await heartbeat())) {
              acquired = null; // not ours anymore; don't release someone else's lock
              throw new Error('run-lock lost (TTL takeover by another process)');
            }
            await prisma.syncState.upsert({
              where: { syncer: name },
              create: { syncer: name, watermark },
              update: { watermark },
            });
          },
          async recordIssue(reason: string, legacyPk: number | string | null, detail?: string) {
            if (opts.dryRun) return;
            const pk = legacyPk === null || legacyPk === undefined ? '' : String(legacyPk);
            try {
              await prisma.syncIssue.upsert({
                where: { syncer_legacyPk_reason: { syncer: name, legacyPk: pk, reason } },
                create: { syncer: name, legacyPk: pk, reason, detail: detail ?? null },
                update: { detail: detail ?? null, occurrences: { increment: 1 }, lastSeenAt: new Date() },
              });
            } catch (err) {
              // issue logging must never fail a syncer
              syncerLog(`WARN recordIssue ${reason} pk=${pk}: ${errCode(err)}`);
            }
          },
        };

        const started = Date.now();
        // A syncer's only checkpoint is at its end, so keep the lock warm on a timer for
        // as long as it runs. On a lost lock we can only log — the running syncer stops at
        // its next checkpoint — but the periodic refresh makes a takeover far less likely.
        const hbTimer = opts.dryRun
          ? null
          : setInterval(() => {
              void heartbeat().then((owned) => {
                if (!owned) log(`WARN: run-lock lost during ${name} — takeover may have happened`);
              });
            }, heartbeatMs);
        hbTimer?.unref();
        try {
          const stats = await syncer.run(syncerCtx);
          results[name] = stats;
          if (!opts.dryRun) {
            await prisma.syncState.upsert({
              where: { syncer: name },
              create: { syncer: name, lastRunAt: new Date(), lastStats: stats as any },
              update: { lastRunAt: new Date(), lastStats: stats as any },
            });
          }
          log(
            `${name}: scanned=${stats.scanned} upserted=${stats.upserted} skipped=${stats.skipped}` +
              `${stats.voided ? ` voided=${stats.voided}` : ''} errors=${stats.errors}` +
              `${skipReasonsSummary(stats)} (${Date.now() - started}ms)`,
          );
        } catch (err: any) {
          results[name] = { ...emptyStats(), errors: 1 };
          log(`ERROR ${name}: ${err?.message ?? err} — continuing with next syncer`);
          console.error(err);
        } finally {
          if (hbTimer) clearInterval(hbTimer);
          if (changeLog) {
            changeLog.close();
            syncerLog(`change-log: ${changeLog.count} row(s) → ${changeLog.path}`);
          }
        }

        // confirm ownership between syncers; a lost lock means another process holds it now
        if (!opts.dryRun && !(await heartbeat())) {
          log('ERROR: run-lock lost (TTL takeover by another process) — aborting remaining syncers');
          acquired = null; // not ours anymore; don't release someone else's lock
          break;
        }
      }
      const em = (ctx.ensureMember as any).stats?.();
      if (em && (em.created || em.redirected || em.adopted)) {
        log(`new legacy members: created=${em.created} redirected=${em.redirected} adopted=${em.adopted}`);
      }

      // members materialised this run have pre-watermark legacy rows elsewhere (kyc/tree/
      // commissions/likes) that the incremental scans will never revisit → targeted backfill
      const newIds: number[] = (ctx.ensureMember as any).newLegacyIds?.() ?? [];
      if (!opts.dryRun && acquired && newIds.length) {
        try {
          const bf = await backfillNewMembers(ctx, newIds);
          results.backfill = bf;
          log(
            `backfill (${newIds.length} new members): scanned=${bf.scanned} upserted=${bf.upserted} ` +
              `skipped=${bf.skipped} errors=${bf.errors}`,
          );
        } catch (err: any) {
          results.backfill = { ...emptyStats(), errors: 1 };
          log(`ERROR backfill: ${err?.message ?? err} — continuing`);
          console.error(err);
        }
      }

      // posts writes comments/likes directly (and backfill can add likes) → rebuild the
      // denormalised counters when either ran
      const backfillWrote = (results.backfill?.upserted ?? 0) > 0;
      if (!opts.dryRun && ((opts.syncers.includes('posts') && !results.posts?.errors) || backfillWrote)) {
        try {
          await recountCounters(prisma, log);
        } catch (err: any) {
          log(`recount failed (non-fatal): ${err?.message ?? err}`);
        }
      }

      // completion summary (one line per cycle — useful for the long-running worker)
      const total = Object.values(results).reduce(
        (a, s) => ({
          scanned: a.scanned + s.scanned,
          upserted: a.upserted + s.upserted,
          skipped: a.skipped + s.skipped,
          errors: a.errors + s.errors,
        }),
        { scanned: 0, upserted: 0, skipped: 0, errors: 0 },
      );
      const secs = ((Date.now() - runStarted) / 1000).toFixed(1);
      log(
        `${total.errors ? '⚠️  cycle finished WITH ERRORS' : '✅ cycle complete'} in ${secs}s — ` +
          `syncers=${opts.syncers.length} scanned=${total.scanned} upserted=${total.upserted} ` +
          `skipped=${total.skipped} errors=${total.errors}${opts.dryRun ? ' (dry-run)' : ''}`,
      );
    } finally {
      await legacy.end();
    }
  } finally {
    if (acquired) await releaseLock(prisma, acquired);
    await prisma.$disconnect();
  }
  return results;
}

export { SYNCER_ORDER };
