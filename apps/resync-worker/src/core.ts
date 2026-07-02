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
import { connectResilientLegacy } from './legacy-db';
import { resyncConfig } from './config';
import { registry, SYNCER_ORDER } from './syncers';
import { makeEnsureMember } from './ensure-member';
import { emptyStats, type RunCtx, type Stats, type SyncerCtx } from './types';

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
}

/** Acquire the DB run-lock. Returns the owned acquiredAt, or null if held elsewhere. */
async function acquireLock(prisma: PrismaClient): Promise<Date | null> {
  await prisma.syncState.createMany({ data: [{ syncer: LOCK_ROW }], skipDuplicates: true });
  const now = new Date();
  const cutoff = new Date(now.getTime() - resyncConfig.lockTtlSec * 1000);
  const res = await prisma.syncState.updateMany({
    where: { syncer: LOCK_ROW, OR: [{ lastRunAt: null }, { lastRunAt: { lt: cutoff } }] },
    data: { lastRunAt: now, lastStats: { host: os.hostname(), pid: process.pid } },
  });
  return res.count === 1 ? now : null;
}

async function releaseLock(prisma: PrismaClient, acquiredAt: Date): Promise<void> {
  // Only clear if we still own it (TTL takeover could have reassigned it).
  await prisma.syncState.updateMany({
    where: { syncer: LOCK_ROW, lastRunAt: acquiredAt },
    data: { lastRunAt: null },
  });
}

async function buildCtx(prisma: PrismaClient, legacy: any, dryRun: boolean): Promise<RunCtx> {
  const redirect = new Map<number, number>();
  for (const r of await prisma.memberRedirect.findMany({ select: { loserLegacyId: true, winnerLegacyId: true } })) {
    redirect.set(r.loserLegacyId, r.winnerLegacyId);
  }
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
  let acquired: Date | null = null;
  try {
    acquired = await acquireLock(prisma);
    if (!acquired) {
      log('another resync run holds the lock — skipping this tick');
      return results;
    }
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
        const since = opts.since !== undefined ? opts.since : (state?.watermark ?? null);

        const syncerCtx: SyncerCtx = {
          ...ctx,
          log: (m: string) => console.log(`[${ts()}] [resync:${name}] ${m}`),
          since,
          async checkpoint(watermark: string) {
            if (opts.dryRun) return;
            await prisma.syncState.upsert({
              where: { syncer: name },
              create: { syncer: name, watermark },
              update: { watermark },
            });
          },
        };

        const started = Date.now();
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
              `${stats.voided ? ` voided=${stats.voided}` : ''} errors=${stats.errors} (${Date.now() - started}ms)`,
          );
        } catch (err: any) {
          results[name] = { ...emptyStats(), errors: 1 };
          log(`ERROR ${name}: ${err?.message ?? err} — continuing with next syncer`);
          console.error(err);
        }
      }
      const em = (ctx.ensureMember as any).stats?.();
      if (em && (em.created || em.redirected || em.adopted)) {
        log(`new legacy members: created=${em.created} redirected=${em.redirected} adopted=${em.adopted}`);
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
