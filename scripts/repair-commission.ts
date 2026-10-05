/* eslint-disable no-console */
/**
 * Repair affiliate commissions that were never committed for an already-PAID order.
 *
 *   pnpm repair:commission --code=BB-20260910-0034            # dry run, one order
 *   pnpm repair:commission --code=BB-...,BB-... --apply
 *   pnpm repair:commission --scan                             # dry run, find every repairable order
 *   pnpm repair:commission --scan --since=2026-08-01 --apply --backdate
 *   pnpm repair:commission --scan --attribute                 # also orders checkout left unattributed
 *
 * Why this exists: `commitCommissionsForPayment` fires once, from the
 * `commerce.payment.success` listener. If the attribution seed was missing AT THAT
 * MOMENT — the buyer's `inviter_id` was null because of the registerByPhone
 * affiliateCode bug (59b175f), a listener threw, the inviter was set by hand
 * afterwards — the commission is simply never written. Nothing retries it.
 *
 * The write ALWAYS goes through the real engine, so rate/tier/schema/chain rules
 * live in exactly one place. The dry-run preview re-derives the same numbers from
 * the same exported helpers; it can in principle drift from the engine loop, which
 * is why it only ever prints.
 *
 * Idempotent: the engine's unique (payment_id, recipient_id, level) makes a second
 * run a no-op, so re-running over an already-repaired order is safe.
 *
 * --attribute (opt-in): an order whose checkout attributed nobody is resolved again
 * with the live resolver as of its `paid_at` — the rules the order would get today
 * (own-code clicks skipped, a click between checkout and payment counts; PRD
 * prd-affiliate-self-visit-attribution.md). A click found that way beats the buyer's
 * inviter, the same precedence checkout applies, and is written to
 * `attributed_affiliator_member_id` on --apply. Without the flag nothing changes.
 *
 * No email: the `affiliate.commission.created` listener is registered by the app,
 * not by this script, so a repaired commission reaches its earner silently.
 *
 * Scope: web/Xendit orders only (`commerce_transactions.provider IS NULL`). An
 * ingested purchase (RevenueCat/Scalev/Lynk.id) is refused — its commission is
 * gated by `affiliate_attribution_claims` ("first settle wins") and by the
 * channel's `triggersAffiliate`, and blindly re-running the engine would bypass
 * both. Repair those by hand after checking the claim row.
 */
import 'dotenv/config';
import { prisma } from '@bb/db';
import { AffiliatorService } from '@bb/domain/affiliate/affiliator.service';
import { attributionService } from '@bb/domain/affiliate/attribution.service';
import {
  AFFILIATE_BASED,
  COMMISSION_STATUS,
  GROWTH_LEVEL_RATES,
  GROWTH_MAX_DEPTH,
  INACTIVE_RATE,
} from '@bb/domain/affiliate/constants';
import { computeAmount, getPerformanceTier } from '@bb/domain/affiliate/utils/compute-amount';
import { walkInviterChain } from '@bb/domain/affiliate/utils/walk-inviter-chain';
import { EVENT_TICKET_PRODUCT_TYPE } from '@bb/domain/event/order';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) =>
  args
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');

const APPLY = flag('apply');
const SCAN = flag('scan');
const BACKDATE = flag('backdate');
const ATTRIBUTE = flag('attribute');
const SINCE = opt('since');
const CODES = (opt('code') ?? '')
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean);

const svc = new AffiliatorService();

interface Target {
  code: string;
  txId: string;
  paymentId: string;
  productId: string;
  memberId: string;
  programId: string | null;
  overrideAffiliatorMemberId: string | null;
  /** Override found by --attribute (not on the order yet); written to the order on --apply. */
  resolvedOverride: boolean;
  /** Base fed to computeAmount — mirrors the listener: net when the channel derived one, else gross. */
  productPrice: number;
  voucherAmount: number;
  channel: string;
  paidAt: Date | null;
}

/** Orders eligible for repair: PAID, web-channel, SUCCESS payment, no commission row yet. */
async function scanTargets(since: Date): Promise<Target[]> {
  const rows = await prisma.$queryRaw<Array<Record<string, any>>>`
    SELECT t.code, t.id AS tx_id, t.product_id, t.member_id, t.program_id, t.amount,
           t.voucher_amount, t.tax_amount, t.attributed_affiliator_member_id, t.paid_at,
           p.id AS payment_id, p.accepted_amount
    FROM commerce_transactions t
    JOIN commerce_payments p ON p.transaction_id = t.id AND p.status = 'SUCCESS'
    JOIN products pr ON pr.id = t.product_id
    JOIN members m ON m.id = t.member_id
    WHERE t.status = 'PAID'
      AND t.provider IS NULL
      AND t.paid_at >= ${since}
      AND pr.type <> ${EVENT_TICKET_PRODUCT_TYPE}
      AND (${ATTRIBUTE} OR t.attributed_affiliator_member_id IS NOT NULL OR m.inviter_id IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM affiliate_commissions c WHERE c.payment_id = p.id)
    ORDER BY t.paid_at
  `;
  return rows.map(toTarget);
}

async function loadTarget(code: string): Promise<Target> {
  const tx = await prisma.commerceTransaction.findUnique({
    where: { code },
    include: {
      payments: { where: { status: 'SUCCESS' }, orderBy: { createdAt: 'asc' } },
      product: { select: { type: true } },
    },
  });
  if (!tx) throw new Error(`${code}: transaction not found`);
  if (tx.status !== 'PAID') throw new Error(`${code}: status is ${tx.status}, not PAID`);
  if (tx.provider)
    throw new Error(
      `${code}: ingested order (provider=${tx.provider}) — see the header note, repair by hand`,
    );
  if (tx.product.type === EVENT_TICKET_PRODUCT_TYPE)
    throw new Error(`${code}: event ticket — no commission scheme`);
  const payment = tx.payments[0];
  if (!payment) throw new Error(`${code}: no SUCCESS payment`);
  return toTarget({
    code: tx.code,
    tx_id: tx.id,
    product_id: tx.productId,
    member_id: tx.memberId,
    program_id: tx.programId,
    amount: tx.amount,
    voucher_amount: tx.voucherAmount,
    tax_amount: tx.taxAmount,
    attributed_affiliator_member_id: tx.attributedAffiliatorMemberId,
    paid_at: tx.paidAt,
    payment_id: payment.id,
    accepted_amount: payment.acceptedAmount,
  });
}

function toTarget(r: Record<string, any>): Target {
  // Listener parity: commission base is what we actually take home when the channel
  // exposes it (RC net), else gross, minus the PPN booked on the order (tax is money
  // forwarded to the state, not revenue). `accepted_amount` defaults to 0 on the web
  // path, so treat 0 as "not derived". `+ voucherAmount` reconstructs the pre-voucher
  // base that computeAmount subtracts again (legacy shape).
  const net = (Number(r.accepted_amount) || Number(r.amount)) - Number(r.tax_amount ?? 0);
  return {
    code: r.code,
    txId: r.tx_id,
    paymentId: r.payment_id,
    productId: r.product_id,
    memberId: r.member_id,
    programId: r.program_id ?? null,
    overrideAffiliatorMemberId: r.attributed_affiliator_member_id ?? null,
    resolvedOverride: false,
    productPrice: net + Number(r.voucher_amount),
    voucherAmount: Number(r.voucher_amount),
    channel: 'xendit', // provider IS NULL → native web checkout, same value both emitters use
    paidAt: r.paid_at ?? null,
  };
}

/**
 * --attribute: resolve an order checkout left unattributed, as of its payment.
 * Returns the target unchanged when the flag is off, the order already has an
 * override, or no qualifying click exists.
 */
async function withResolvedOverride(t: Target): Promise<Target> {
  if (!ATTRIBUTE || t.overrideAffiliatorMemberId || !t.paidAt) return t;
  const found = await attributionService.resolveOverrideAffiliatorMemberId(
    t.memberId,
    null,
    t.productId,
    t.paidAt,
  );
  return found ? { ...t, overrideAffiliatorMemberId: found, resolvedOverride: true } : t;
}

/**
 * What the engine WOULD write. Mirrors `commitCommissionsForPayment`'s loop over
 * the same helpers — including that the walk does NOT stop at a PERFORMANCE node
 * (`stopOnPerformance: false`): a PERFORMANCE node above level 1 just earns nothing,
 * a GROWTH node above it still does. Preview only — never a source of a stored number.
 */
async function preview(t: Target) {
  let seed = t.overrideAffiliatorMemberId;
  if (!seed) {
    const buyer = await prisma.member.findUnique({
      where: { id: t.memberId },
      select: { inviterId: true },
    });
    seed = buyer?.inviterId ?? null;
  }
  if (!seed) return [];

  const chain = await walkInviterChain(seed, {
    maxDepth: GROWTH_MAX_DEPTH,
    stopOnPerformance: false,
  });
  const out: Array<{
    level: number;
    recipientId: string;
    name: string;
    based: string;
    rate: number;
    amount: number;
  }> = [];

  for (const node of chain) {
    if (node.id === t.memberId) continue; // buyer never earns on their own purchase
    let rate: number | null = null;
    if (node.affiliateBased === AFFILIATE_BASED.INACTIVE)
      rate = node.level === 1 ? INACTIVE_RATE : null;
    else if (node.affiliateBased === AFFILIATE_BASED.PERFORMANCE)
      rate = node.level === 1 ? getPerformanceTier(await lifetimeAmount(node.id)).rate : null;
    else if (node.affiliateBased === AFFILIATE_BASED.GROWTH)
      rate = node.level <= GROWTH_LEVEL_RATES.length ? GROWTH_LEVEL_RATES[node.level - 1] : null;

    if (rate !== null) {
      const amount = computeAmount(t.productPrice, t.voucherAmount, rate);
      if (amount > 0) {
        const m = await prisma.member.findUnique({
          where: { id: node.id },
          select: { fullName: true },
        });
        out.push({
          level: node.level,
          recipientId: node.id,
          name: m?.fullName ?? '?',
          based: node.affiliateBased,
          rate,
          amount,
        });
      }
    }
  }
  return out;
}

async function lifetimeAmount(memberId: string): Promise<number> {
  const agg = await prisma.affiliateCommission.aggregate({
    where: {
      recipientId: memberId,
      status: { not: COMMISSION_STATUS.VOIDED },
      affiliateBased: { not: AFFILIATE_BASED.INACTIVE },
    },
    _sum: { amount: true },
  });
  return agg._sum.amount ?? 0;
}

async function repair(t: Target): Promise<number> {
  if (t.resolvedOverride) {
    // Conditional: never over an attribution something else wrote meanwhile.
    await prisma.commerceTransaction.updateMany({
      where: { id: t.txId, attributedAffiliatorMemberId: null },
      data: { attributedAffiliatorMemberId: t.overrideAffiliatorMemberId },
    });
  }
  const before = new Set(
    (
      await prisma.affiliateCommission.findMany({
        where: { paymentId: t.paymentId },
        select: { id: true },
      })
    ).map((r) => r.id),
  );

  const { committed } = await svc.commitCommissionsForPayment({
    paymentId: t.paymentId,
    productId: t.productId,
    productPrice: t.productPrice,
    voucherAmount: t.voucherAmount,
    buyerMemberId: t.memberId,
    programId: t.programId,
    overrideAffiliatorMemberId: t.overrideAffiliatorMemberId,
    channel: t.channel,
  });

  // The 7-day PENDING→BALANCE hold keys on `created_at`, which the engine stamps
  // with now(). Left alone, a commission repaired weeks late starts its hold today.
  // --backdate restores the timeline the order would have had.
  if (BACKDATE && committed > 0 && t.paidAt) {
    const fresh = (
      await prisma.affiliateCommission.findMany({
        where: { paymentId: t.paymentId },
        select: { id: true },
      })
    )
      .map((r) => r.id)
      .filter((id) => !before.has(id));
    if (fresh.length) {
      await prisma.$executeRawUnsafe(
        `UPDATE affiliate_commissions SET created_at = $1 WHERE id = ANY($2::uuid[])`,
        t.paidAt,
        fresh,
      );
    }
  }
  return committed;
}

async function main() {
  if (!SCAN && CODES.length === 0) {
    console.error(
      'usage: pnpm repair:commission (--code=BB-...[,BB-...] | --scan) [--since=YYYY-MM-DD] [--attribute] [--apply] [--backdate]',
    );
    process.exitCode = 1;
    return;
  }

  const since = SINCE ? new Date(SINCE) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const targets: Target[] = [];
  const loaded: Target[] = [];
  if (SCAN) loaded.push(...(await scanTargets(since)));
  for (const code of CODES) loaded.push(await loadTarget(code));
  for (const t of loaded) targets.push(await withResolvedOverride(t));

  if (targets.length === 0) {
    console.log(`nothing to repair (scan since ${since.toISOString().slice(0, 10)})`);
    return;
  }

  console.log(`${targets.length} order(s) with a SUCCESS payment and no commission row\n`);
  let totalRows = 0;
  let totalAmount = 0;

  let unattributable = 0;
  for (const t of targets) {
    const rows = await preview(t);
    // --attribute widens the scan to every unattributed order; one with no click and
    // no inviter has nobody to pay and would only bury the real targets.
    if (ATTRIBUTE && rows.length === 0 && !t.overrideAffiliatorMemberId) {
      unattributable++;
      continue;
    }
    totalRows += rows.length;
    totalAmount += rows.reduce((s, r) => s + r.amount, 0);
    console.log(
      `${t.code}  paid=${t.paidAt?.toISOString() ?? '-'}  base=${t.productPrice}  voucher=${t.voucherAmount}` +
        (t.resolvedOverride ? `  seed=click(${t.overrideAffiliatorMemberId}) [--attribute]` : ''),
    );
    if (rows.length === 0) {
      console.log('   → no payable recipient (no seed, or every rate resolves to 0)');
    } else {
      for (const r of rows) {
        console.log(
          `   → L${r.level} ${r.name} (${r.recipientId}) ${r.based} ${r.rate}% = ${r.amount.toLocaleString('id-ID')}`,
        );
      }
    }
    if (APPLY) {
      const committed = await repair(t);
      console.log(
        `   ✓ committed ${committed} row(s)${BACKDATE ? ' (created_at backdated to paid_at)' : ''}`,
      );
    }
  }

  if (unattributable)
    console.log(`\n(${unattributable} order(s) with no qualifying click and no inviter not shown)`);
  console.log(`\ntotal: ${totalRows} row(s), ${totalAmount.toLocaleString('id-ID')} IDR`);
  if (!APPLY) console.log('DRY RUN — re-run with --apply to write');
}

main()
  .catch((e) => {
    console.error('ERR:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
