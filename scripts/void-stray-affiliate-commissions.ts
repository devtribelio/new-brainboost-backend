/* eslint-disable no-console */
/**
 * Data cleanup for the IAP affiliate over-attribution bug (B-2/B-3).
 * See docs/specs/affiliate-overattribution-fix.md.
 *
 * Before the fix, a sticky RevenueCat `affiliate_code` subscriber attribute paid
 * commission on purchases the affiliator never referred (renewals, re-syncs,
 * unrelated later purchases, delete+rebuy bursts). This script VOIDs those stray
 * `PENDING` commissions BEFORE the `affiliate-pending-to-balance` job promotes
 * them to a withdrawable balance.
 *
 *   pnpm tsx scripts/void-stray-affiliate-commissions.ts            # DRY-RUN (default)
 *   pnpm tsx scripts/void-stray-affiliate-commissions.ts --apply    # actually VOID
 *
 * Flags:
 *   --apply              Perform the VOID. Without it, only reports (safe default).
 *   --channel=revenuecat Channel to scan (default revenuecat). Repeatable via comma.
 *   --since=2026-01-01   Only commissions created on/after this date.
 *   --cookie-days=30     Visit lookback window (match app_settings affiliate.cookieDays).
 *   --strict-window      Also require the justifying visit to fall within the
 *                        cookie window before the purchase (default: ANY visit
 *                        buyer→affiliator justifies — conservative, avoids false voids).
 *   --limit=N            Cap groups processed (debug).
 *
 * Justification (a commission group is KEPT when EITHER holds):
 *   1. the seed affiliator (level-1 recipient) is an inviter-chain ancestor of the
 *      buyer (a legitimate permanent-inviter commission), OR
 *   2. there is an AffiliateVisit from the buyer to that seed affiliator.
 * Only groups justified by NEITHER are voided. Conservative by design: when in
 * doubt it keeps the commission.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: ['warn', 'error'] });

const GROWTH_MAX_DEPTH = 4; // inviter-chain walk depth (legacy parity)
const VOID_REASON = 'cleanup:iap-over-attribution';

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function parseArgs(argv: string[]) {
  const get = (name: string) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const channels = (get('channel') ?? 'revenuecat')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  return {
    apply: argv.includes('--apply'),
    strictWindow: argv.includes('--strict-window'),
    channels,
    since: get('since') ? new Date(get('since') as string) : undefined,
    cookieDays: Number.parseInt(get('cookie-days') ?? '30', 10),
    limit: get('limit') ? Number.parseInt(get('limit') as string, 10) : undefined,
  };
}

/** Is `seedId` an inviter-chain ancestor of `buyerId` (within GROWTH depth)? */
async function isInviterAncestor(buyerId: string, seedId: string): Promise<boolean> {
  let current: string | null = buyerId;
  for (let i = 0; i < GROWTH_MAX_DEPTH && current; i++) {
    const m: { inviterId: string | null } | null = await prisma.member.findUnique({
      where: { id: current },
      select: { inviterId: true },
    });
    if (!m?.inviterId) return false;
    if (m.inviterId === seedId) return true;
    current = m.inviterId;
  }
  return false;
}

async function hasVisit(
  buyerId: string,
  seedId: string,
  purchaseAt: Date | null,
  cookieDays: number,
  strictWindow: boolean,
): Promise<boolean> {
  const where: Record<string, unknown> = { memberId: buyerId, affiliatorMemberId: seedId };
  if (strictWindow && purchaseAt) {
    const since = new Date(purchaseAt.getTime() - cookieDays * 24 * 60 * 60 * 1000);
    where.createdAt = { gte: since, lte: purchaseAt };
  }
  const v = await prisma.affiliateVisit.findFirst({ where, select: { id: true } });
  return v != null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  log(
    `mode=${args.apply ? 'APPLY' : 'DRY-RUN'} channels=[${args.channels.join(',')}] ` +
      `cookieDays=${args.cookieDays} strictWindow=${args.strictWindow}` +
      `${args.since ? ` since=${args.since.toISOString().slice(0, 10)}` : ''}` +
      `${args.limit ? ` limit=${args.limit}` : ''}`,
  );

  // Candidate strays: PENDING commissions on the scanned channel(s).
  const commissions = await prisma.affiliateCommission.findMany({
    where: {
      status: 'PENDING',
      channel: { in: args.channels },
      ...(args.since ? { createdAt: { gte: args.since } } : {}),
      paymentId: { not: null },
      buyerMemberId: { not: null },
    },
    select: {
      id: true,
      paymentId: true,
      buyerMemberId: true,
      recipientId: true,
      level: true,
      amount: true,
    },
    orderBy: [{ paymentId: 'asc' }, { level: 'asc' }],
  });
  log(`found ${commissions.length} PENDING commission row(s) on channel(s)`);

  // Group by paymentId — one purchase = one commission set (seed + upline).
  const groups = new Map<string, typeof commissions>();
  for (const c of commissions) {
    const arr = groups.get(c.paymentId!) ?? [];
    arr.push(c);
    groups.set(c.paymentId!, arr);
  }

  // Purchase time per payment (for --strict-window).
  const paymentIds = [...groups.keys()];
  const payments = await prisma.commercePayment.findMany({
    where: { id: { in: paymentIds } },
    select: { id: true, paidAt: true },
  });
  const paidAtById = new Map(payments.map((p) => [p.id, p.paidAt]));

  let groupsSeen = 0;
  let voidGroups = 0;
  let voidRows = 0;
  let voidAmount = 0;
  let keptGroups = 0;
  const reasonsKept = { inviter: 0, visit: 0 };

  for (const [paymentId, rows] of groups) {
    if (args.limit && groupsSeen >= args.limit) break;
    groupsSeen++;

    const buyerId = rows[0].buyerMemberId!;
    const seed = rows.reduce((a, b) => (a.level <= b.level ? a : b)); // level-1 recipient
    const seedId = seed.recipientId;

    // A buyer is never a valid affiliator for their own purchase — but that's
    // already guarded at write time; here we only decide justified vs stray.
    const inviterOk = await isInviterAncestor(buyerId, seedId);
    let visitOk = false;
    if (!inviterOk) {
      visitOk = await hasVisit(
        buyerId,
        seedId,
        paidAtById.get(paymentId) ?? null,
        args.cookieDays,
        args.strictWindow,
      );
    }

    if (inviterOk || visitOk) {
      keptGroups++;
      if (inviterOk) reasonsKept.inviter++;
      else reasonsKept.visit++;
      continue;
    }

    // Stray — void the whole group.
    const groupAmount = rows.reduce((s, r) => s + r.amount, 0);
    voidGroups++;
    voidRows += rows.length;
    voidAmount += groupAmount;
    log(
      `  STRAY payment=${paymentId} buyer=${buyerId} seed=${seedId} ` +
        `rows=${rows.length} amount=${groupAmount}` +
        `${args.apply ? ' → VOIDING' : ' (dry-run)'}`,
    );

    if (args.apply) {
      await prisma.affiliateCommission.updateMany({
        where: { id: { in: rows.map((r) => r.id) }, status: 'PENDING' },
        data: { status: 'VOIDED', voidedAt: new Date(), voidedReason: VOID_REASON },
      });
    }
  }

  log('────────────────────────────────────────');
  log(`groups processed : ${groupsSeen}`);
  log(`kept (justified) : ${keptGroups} (inviter=${reasonsKept.inviter}, visit=${reasonsKept.visit})`);
  log(`stray groups     : ${voidGroups}`);
  log(`stray rows       : ${voidRows}`);
  log(`stray amount      : ${voidAmount}`);
  log(args.apply ? 'APPLIED — stray commissions set to VOIDED.' : 'DRY-RUN — re-run with --apply to void.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
