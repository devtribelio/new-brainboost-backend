/* eslint-disable no-console */
/**
 * Subscription grant tooling (PRD BE-20, scope per BB-96 + correction comment).
 *
 * Modes:
 *   pnpm grant:subscription --email x [--plan SOLO_12M] [--months 12] [--dry-run]
 *   pnpm grant:subscription --member-id <uuid> [...]
 *   pnpm grant:subscription --list-eligible  [--threshold 2000000]
 *   pnpm grant:subscription --grant-eligible [--plan SOLO_12M] [--dry-run]
 *
 * Eligibility (campaign "upgrade claim", buyers > 2jt) sums spend from TWO
 * sources — commerce_transactions only holds NEW-platform purchases, the
 * legacy migration never brought transactions over:
 *   1. Postgres:  SUM(amount) of commerce_transactions status=PAID
 *   2. Legacy MariaDB (LEGACY_DB_* env, transition period only):
 *      course_payment + product_bundle_payment, payment_status=SUCCESS,
 *      brainboost-scoped, spend = GREATEST(amount - amount_voucher, 0)
 *      (payment_amount is NULL on many rows — do not use it),
 *      mapped to new members via members.legacy_id (+ member_redirect dedup).
 * Eligibility modes REFUSE to run without LEGACY_DB_* — half the data would
 * silently produce a wrong campaign list.
 *
 * Batch is once-per-campaign but safely re-runnable: skips members with an
 * ACTIVE sub, a seat on an active sub, or ANY prior grant in the
 * subscription_activations ledger (kind='grant' — survives sub expiry, so a
 * lapsed granted sub is never re-granted). Single --email grant is the
 * long-lived CS tool and MAY extend (use --dry-run first).
 *
 * Grants go through SubscriptionService.grant (seats + ledger) and emit
 * subscription.activated/renewed so the notification/email listeners fire —
 * granted subs behave exactly like paid ones.
 */
import type { Connection } from 'mysql2/promise';
import type { PrismaClient } from '@prisma/client';
import { SubscriptionService } from '@bb/domain/subscription/subscription.service';
import { subscriptionEvents } from '@bb/common/events/subscription-events';

export const DEFAULT_THRESHOLD = 2_000_000;
export const DEFAULT_PLAN = 'SOLO_12M';

export interface EligibleRow {
  memberId: string;
  email: string | null;
  fullName: string | null;
  legacyTotal: number;
  newTotal: number;
  total: number;
  action: 'grant' | 'skip';
  skipReason?: 'active-subscription' | 'holds-seat' | 'already-granted';
}

/**
 * Legacy spend per legacy member id (brainboost only). Course payments join
 * `course.client`; bundle payments qualify when any detail line is a
 * brainboost course (bundle amount may include non-course items — acceptable
 * over-count for campaign eligibility, noted for the verification pass).
 */
export async function fetchLegacyTotals(legacy: Connection): Promise<Map<number, number>> {
  const totals = new Map<number, number>();
  const add = (memberId: number, amount: number) =>
    totals.set(memberId, (totals.get(memberId) ?? 0) + amount);

  const [courseRows] = await legacy.query(
    `SELECT cp.member_id AS member_id,
            SUM(GREATEST(COALESCE(cp.amount,0) - COALESCE(cp.amount_voucher,0), 0)) AS total
     FROM course_payment cp
     JOIN course c ON c.course_id = cp.course_id
     WHERE cp.payment_status = 'SUCCESS' AND c.client = 'brainboost' AND cp.member_id IS NOT NULL
     GROUP BY cp.member_id`,
  );
  for (const r of courseRows as Array<{ member_id: number; total: number }>) {
    add(Number(r.member_id), Number(r.total));
  }

  const [bundleRows] = await legacy.query(
    `SELECT bp.member_id AS member_id,
            SUM(GREATEST(COALESCE(bp.amount,0) - COALESCE(bp.amount_voucher,0), 0)) AS total
     FROM product_bundle_payment bp
     WHERE bp.payment_status = 'SUCCESS' AND bp.member_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM product_bundle_payment_detail dd
         JOIN course c ON c.course_id = dd.product_id
         WHERE dd.product_bundle_payment_id = bp.product_bundle_payment_id
           AND dd.product_model = 'TBModel_Course' AND c.client = 'brainboost'
       )
     GROUP BY bp.member_id`,
  );
  for (const r of bundleRows as Array<{ member_id: number; total: number }>) {
    add(Number(r.member_id), Number(r.total));
  }

  return totals;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Merge legacy + new spend per NEW member and decide grant/skip.
 * `legacyTotals` is injected (fetched by fetchLegacyTotals in the CLI) so the
 * merge/guard logic is testable without a MariaDB.
 */
export async function computeEligibility(
  prisma: PrismaClient,
  legacyTotals: Map<number, number>,
  opts: { threshold?: number } = {},
): Promise<{ rows: EligibleRow[]; unmappedLegacyMembers: number }> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;

  // Fold dedup losers into winners (member_redirect: loser -> winner legacy id).
  const redirects = await prisma.memberRedirect.findMany();
  const folded = new Map<number, number>();
  const winnerOf = new Map(redirects.map((r) => [r.loserLegacyId, r.winnerLegacyId]));
  for (const [legacyId, total] of legacyTotals) {
    const target = winnerOf.get(legacyId) ?? legacyId;
    folded.set(target, (folded.get(target) ?? 0) + total);
  }

  // Map legacy ids -> new members (chunked: the full map is ~45k ids).
  const legacyIds = [...folded.keys()];
  const byLegacyId = new Map<number, { id: string; email: string | null; fullName: string | null }>();
  for (const ids of chunk(legacyIds, 5_000)) {
    const members = await prisma.member.findMany({
      where: { legacyId: { in: ids } },
      select: { id: true, legacyId: true, email: true, fullName: true },
    });
    for (const m of members) byLegacyId.set(m.legacyId!, m);
  }
  const unmappedLegacyMembers = legacyIds.filter((id) => !byLegacyId.has(id)).length;

  // New-platform spend.
  const newTotals = await prisma.commerceTransaction.groupBy({
    by: ['memberId'],
    where: { status: 'PAID' },
    _sum: { amount: true },
  });

  // Combine per NEW member id.
  const combined = new Map<string, { legacyTotal: number; newTotal: number }>();
  for (const [legacyId, total] of folded) {
    const m = byLegacyId.get(legacyId);
    if (!m) continue;
    const cur = combined.get(m.id) ?? { legacyTotal: 0, newTotal: 0 };
    cur.legacyTotal += total;
    combined.set(m.id, cur);
  }
  for (const t of newTotals) {
    const cur = combined.get(t.memberId) ?? { legacyTotal: 0, newTotal: 0 };
    cur.newTotal += t._sum.amount ?? 0;
    combined.set(t.memberId, cur);
  }

  const candidateIds = [...combined.entries()]
    .filter(([, v]) => v.legacyTotal + v.newTotal > threshold)
    .map(([id]) => id);
  if (candidateIds.length === 0) return { rows: [], unmappedLegacyMembers };

  // Skip guards (batch is once-per-campaign):
  const [activeSubs, seats, priorGrants, memberRows] = await Promise.all([
    prisma.memberSubscription.findMany({
      where: { ownerId: { in: candidateIds }, status: 'ACTIVE' },
      select: { ownerId: true },
    }),
    prisma.subscriptionSeat.findMany({
      where: { memberId: { in: candidateIds }, subscription: { status: 'ACTIVE' } },
      select: { memberId: true },
    }),
    // Ledger, not sub status: an expired granted sub must never be re-granted.
    prisma.subscriptionActivation.findMany({
      where: { kind: 'grant', subscription: { ownerId: { in: candidateIds } } },
      select: { subscription: { select: { ownerId: true } } },
    }),
    prisma.member.findMany({
      where: { id: { in: candidateIds } },
      select: { id: true, email: true, fullName: true },
    }),
  ]);
  const hasActiveSub = new Set(activeSubs.map((s) => s.ownerId));
  const hasSeat = new Set(seats.map((s) => s.memberId!));
  const hasGrant = new Set(priorGrants.map((g) => g.subscription.ownerId));
  const memberById = new Map(memberRows.map((m) => [m.id, m]));

  const rows: EligibleRow[] = candidateIds.map((id) => {
    const v = combined.get(id)!;
    const m = memberById.get(id);
    const skipReason = hasGrant.has(id)
      ? ('already-granted' as const)
      : hasActiveSub.has(id)
        ? ('active-subscription' as const)
        : hasSeat.has(id)
          ? ('holds-seat' as const)
          : undefined;
    return {
      memberId: id,
      email: m?.email ?? null,
      fullName: m?.fullName ?? null,
      legacyTotal: v.legacyTotal,
      newTotal: v.newTotal,
      total: v.legacyTotal + v.newTotal,
      action: skipReason ? 'skip' : 'grant',
      ...(skipReason ? { skipReason } : {}),
    };
  });
  rows.sort((a, b) => b.total - a.total);
  return { rows, unmappedLegacyMembers };
}

async function emitGrantEvent(
  prisma: PrismaClient,
  outcome: 'created' | 'extended',
  sub: { id: string; ownerId: string; planId: string; expiresAt: Date; source: string },
) {
  const plan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { id: sub.planId } });
  const base = {
    subscriptionId: sub.id,
    ownerId: sub.ownerId,
    planId: plan.id,
    planCode: plan.code,
    tier: plan.tier,
    expiresAt: sub.expiresAt,
    source: sub.source,
    transactionId: null,
  };
  if (outcome === 'created') subscriptionEvents.emit('subscription.activated', base);
  else subscriptionEvents.emit('subscription.renewed', { ...base, planChanged: false });
}

/** Batch grant every action='grant' row. Returns per-row results for the report. */
export async function grantEligible(
  prisma: PrismaClient,
  service: SubscriptionService,
  rows: EligibleRow[],
  opts: { planCode?: string; months?: number; dryRun?: boolean } = {},
): Promise<{ granted: number; skipped: number; failed: number }> {
  const planCode = opts.planCode ?? DEFAULT_PLAN;
  let granted = 0;
  let failed = 0;
  const skipped = rows.filter((r) => r.action === 'skip').length;

  for (const row of rows) {
    if (row.action !== 'grant') continue;
    if (opts.dryRun) {
      console.log(`  would grant ${planCode} → ${row.email ?? row.memberId} (total ${row.total})`);
      granted++;
      continue;
    }
    try {
      const res = await service.grant(row.memberId, planCode, opts.months);
      await emitGrantEvent(prisma, res.outcome, res.subscription);
      granted++;
      console.log(
        `  granted ${planCode} → ${row.email ?? row.memberId} (sub ${res.subscription.id}, expires ${res.subscription.expiresAt.toISOString()})`,
      );
    } catch (e) {
      failed++;
      console.error(`  FAILED ${row.email ?? row.memberId}:`, (e as Error).message);
    }
  }
  return { granted, skipped, failed };
}

/** Single-member grant (CS tool — MAY extend an active same-plan sub). */
export async function grantOne(
  prisma: PrismaClient,
  service: SubscriptionService,
  opts: { email?: string; memberId?: string; planCode?: string; months?: number; dryRun?: boolean },
): Promise<{ outcome: 'created' | 'extended' | 'dry-run'; memberId: string }> {
  const planCode = opts.planCode ?? DEFAULT_PLAN;
  const member = opts.memberId
    ? await prisma.member.findUnique({ where: { id: opts.memberId } })
    : opts.email
      ? await prisma.member.findUnique({ where: { email: opts.email.toLowerCase() } })
      : null;
  if (!member) throw new Error(`Member not found (${opts.memberId ?? opts.email ?? 'no identifier'})`);

  if (opts.dryRun) {
    const active = await prisma.memberSubscription.findFirst({
      where: { ownerId: member.id, status: 'ACTIVE' },
      include: { plan: true },
    });
    const intent = !active
      ? `CREATE new ${planCode} sub`
      : active.plan.code === planCode
        ? `EXTEND existing ${planCode} sub (expires ${active.expiresAt.toISOString()})`
        : `REJECT — active sub on different plan ${active.plan.code}`;
    console.log(`  dry-run: ${member.email ?? member.id} → ${intent}`);
    return { outcome: 'dry-run', memberId: member.id };
  }

  const res = await service.grant(member.id, planCode, opts.months);
  await emitGrantEvent(prisma, res.outcome, res.subscription);
  console.log(
    `  ${res.outcome} ${planCode} → ${member.email ?? member.id} (expires ${res.subscription.expiresAt.toISOString()})`,
  );
  return { outcome: res.outcome, memberId: member.id };
}

function printEligibleTable(rows: EligibleRow[]): void {
  console.log(
    ['email'.padEnd(40), 'name'.padEnd(24), 'legacy'.padStart(12), 'new'.padStart(12), 'total'.padStart(12), 'action'].join('  '),
  );
  for (const r of rows) {
    console.log(
      [
        (r.email ?? r.memberId).padEnd(40),
        (r.fullName ?? '-').slice(0, 24).padEnd(24),
        String(r.legacyTotal).padStart(12),
        String(r.newTotal).padStart(12),
        String(r.total).padStart(12),
        r.action + (r.skipReason ? ` (${r.skipReason})` : ''),
      ].join('  '),
    );
  }
}

/* c8 ignore start */
// CLI entry — specs import the functions above directly.
if (process.argv[1]?.endsWith('grant-subscription.ts')) {
  void (async () => {
    await import('dotenv/config');
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    const service = new SubscriptionService();

    const argv = process.argv.slice(2);
    const flag = (name: string) => argv.includes(`--${name}`);
    const value = (name: string) => {
      const i = argv.indexOf(`--${name}`);
      return i >= 0 ? argv[i + 1] : undefined;
    };
    const dryRun = flag('dry-run');
    const planCode = value('plan') ?? DEFAULT_PLAN;
    const months = value('months') ? Number(value('months')) : undefined;
    const threshold = value('threshold') ? Number(value('threshold')) : DEFAULT_THRESHOLD;

    // Grants must produce notifications/emails like paid subs — a one-shot CLI
    // has no app bootstrap, so wire the listeners here.
    const { registerSubscriptionNotificationListener } = await import(
      '@bb/domain/notification/listeners/subscription.listener'
    );
    const { registerSubscriptionEmailListeners } = await import(
      '@bb/domain/comms/listeners/subscription-email.listener'
    );
    registerSubscriptionNotificationListener();
    registerSubscriptionEmailListeners();

    try {
      if (flag('list-eligible') || flag('grant-eligible')) {
        // Hard requirement: without the legacy DB the list is silently HALF the
        // data (new-platform only) — refuse instead. connectLegacyDb throws a
        // clear error when LEGACY_DB_* is missing.
        const { connectLegacyDb } = await import('./legacy-db');
        const legacy = await connectLegacyDb({ dateStrings: true });
        console.log('[grant] fetching legacy spend (course + bundle, brainboost)…');
        const legacyTotals = await fetchLegacyTotals(legacy);
        await legacy.end();
        console.log(`[grant] legacy paying members: ${legacyTotals.size}`);

        const { rows, unmappedLegacyMembers } = await computeEligibility(prisma, legacyTotals, {
          threshold,
        });
        if (unmappedLegacyMembers > 0) {
          console.warn(
            `[grant] WARNING: ${unmappedLegacyMembers} legacy paying members have no new-platform account (not migrated?) — they cannot receive a grant`,
          );
        }
        console.log(`[grant] eligible (> ${threshold}): ${rows.length}\n`);
        printEligibleTable(rows);

        if (flag('grant-eligible')) {
          const stats = await grantEligible(prisma, service, rows, { planCode, months, dryRun });
          console.log(
            `\n[grant] ${dryRun ? 'DRY RUN — ' : ''}granted: ${stats.granted}, skipped: ${stats.skipped}, failed: ${stats.failed}`,
          );
        }
      } else if (value('email') || value('member-id')) {
        await grantOne(prisma, service, {
          email: value('email'),
          memberId: value('member-id'),
          planCode,
          months,
          dryRun,
        });
      } else {
        console.log(
          'Usage: --email x | --member-id x [--plan SOLO_12M] [--months N] [--dry-run]\n       --list-eligible | --grant-eligible [--threshold 2000000] [--plan] [--dry-run]',
        );
        process.exitCode = 1;
      }
      // Let the async notification/email listeners flush before disconnecting.
      await new Promise((r) => setTimeout(r, 1_000));
    } catch (e) {
      console.error(e);
      process.exitCode = 1;
    } finally {
      await prisma.$disconnect();
    }
  })();
}
/* c8 ignore stop */
