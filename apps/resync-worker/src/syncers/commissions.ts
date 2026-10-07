/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Commissions syncer — incremental port of migrate-affiliate-commissions.ts.
 *
 * SOURCE legacy affiliator_commision.
 * STATUS legacy rows → MIGRATED (count toward lifetime/tier, not balance); is_expired=1
 *        → VOIDED (excluded from lifetime). Both ride the `updated` watermark.
 * GUARD  upsert keyed legacyId — new Xendit commissions have legacyId=null, so this never
 *        touches PENDING/BALANCE/VOIDED rows owned by the new flow.
 * BUYER  from the payment row (payment_model → table.member_id), not member_downline_id —
 *        see ./commission-rules.ts. The update branch refreshes buyer + product.
 * See docs/legacy-resync-plan.md §6.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { resyncConfig } from '../config';
import { emptyStats, type RunCtx, type Stats, type Syncer, type SyncerCtx } from '../types';
import { buyerLegacyIdSql, planCommissionUpdate, resolveAffiliateBased } from './commission-rules';
import { errCode, markSkip, runConcurrent, sinceBound, toDate, WatermarkTracker } from '../util';

const PAGE = 5000;

function intOf(v: any): number {
  return Math.round(Number(v ?? 0)) || 0;
}

export interface CommissionMaps {
  productByCourse: Map<number, string>;
  programByNapa: Map<number, string>;
}

/** legacy course_id -> Product.id + legacy napa_id -> AffiliateProgram.id lookups. */
export async function buildCommissionMaps(ctx: RunCtx): Promise<CommissionMaps> {
  const productByCourse = new Map<number, string>();
  for (const p of await ctx.prisma.product.findMany({
    where: { type: { in: ['course', 'mini_course'] }, legacyId: { not: null } },
    select: { id: true, legacyId: true },
  })) {
    if (p.legacyId !== null) productByCourse.set(p.legacyId, p.id);
  }
  const programByNapa = new Map<number, string>();
  for (const g of await ctx.prisma.affiliateProgram.findMany({
    where: { legacyId: { not: null } },
    select: { id: true, legacyId: true },
  })) {
    if (g.legacyId !== null) programByNapa.set(g.legacyId, g.id);
  }
  return { productByCourse, programByNapa };
}

/**
 * Process one legacy affiliator_commision row (resolve + upsert). Shared with backfill.
 * Returns false when the write errored — the caller must not checkpoint past this row.
 */
export async function applyCommissionRow(ctx: RunCtx, r: any, maps: CommissionMaps, stats: Stats): Promise<boolean> {
  const isCourse = typeof r.product_model === 'string' && r.product_model.includes('Course');
  const productId = isCourse ? maps.productByCourse.get(Number(r.product_id)) ?? null : null;
  // Only a brainboost-course commission puts a member in scope → create the recipient
  // on demand. A non-BB commission attaches only if the recipient is already migrated
  // (resolveMember), never materialising an out-of-scope member.
  const recipientId =
    productId !== null
      ? await ctx.ensureMember(Number(r.member_recipient_id))
      : ctx.resolveMember(Number(r.member_recipient_id));
  if (!recipientId) {
    markSkip(stats, 'recipient_unresolved', r.member_recipient_id);
    void ctx.recordIssue?.('recipient_unresolved', r.member_recipient_id, `commission_id=${r.affiliator_commision_id}, product_id=${r.product_id}`);
    return true;
  }
  if (ctx.dryRun) {
    stats.upserted += 1;
    if (Number(r.is_expired) === 1) stats.voided = (stats.voided ?? 0) + 1;
    return true;
  }
  const programId = maps.programByNapa.get(Number(r.network_account_product_affiliator_id)) ?? null;
  const level = intOf(r.level) || 1;
  // NULL affiliate_based on a level≥2 row is GROWTH (PERFORMANCE pays L1 only) — audit 08 F5.
  const based = resolveAffiliateBased(r.affiliate_based, level);
  const status = Number(r.is_expired) === 1 ? 'VOIDED' : 'MIGRATED';
  // buyer = payment row's member (see ./commission-rules.ts), NOT member_downline_id.
  // A BB-course buyer is in scope by definition (same rule as the recipient above).
  const buyerLegacyId = r.buyer_member_id != null ? Number(r.buyer_member_id) : null;
  const buyerMemberId =
    (productId !== null ? await ctx.ensureMember(buyerLegacyId) : ctx.resolveMember(buyerLegacyId)) ?? null;

  const fields = {
    recipientId,
    buyerMemberId,
    programId,
    productId,
    paymentId: null,
    paymentLegacyId: r.payment_id != null ? Number(r.payment_id) : null,
    level,
    affiliateBased: based,
    productPrice: intOf(r.product_price),
    voucherAmount: 0,
    commissionRate: intOf(r.commision_amount),
    amount: intOf(r.price_recipient),
    status,
    createdAt: toDate(r.created) ?? new Date(),
  };
  try {
    await ctx.prisma.affiliateCommission.upsert({
      where: { legacyId: Number(r.affiliator_commision_id) },
      create: { legacyId: Number(r.affiliator_commision_id), ...fields },
      // only the legacy-owned fields (+ buyer/product so a forced re-scan heals old rows);
      // never demote a non-legacy row (no collision anyway)
      update: planCommissionUpdate(fields),
    });
    stats.upserted += 1;
    if (status === 'VOIDED') stats.voided = (stats.voided ?? 0) + 1;
  } catch (err: any) {
    if (err?.code === 'P2002') {
      markSkip(stats, 'unique_clash', r.affiliator_commision_id); // uniq(payment,recipient,level) clash
    } else {
      stats.errors += 1;
      ctx.log(`ERROR write affiliator_commision_id=${r.affiliator_commision_id}: ${errCode(err)}`);
      return false;
    }
  }
  return true;
}

export const COMMISSION_COLS = `affiliator_commision_id, member_recipient_id, member_downline_id, level,
                payment_id, product_model, product_id, network_account_product_affiliator_id,
                product_price, commision_amount, price_recipient, affiliate_based,
                is_expired, created, ${buyerLegacyIdSql()}, COALESCE(\`updated\`, \`created\`) AS wm`;

export const commissionsSyncer: Syncer = {
  name: 'commissions',
  async run(ctx: SyncerCtx): Promise<Stats> {
    const stats = emptyStats();
    const since = sinceBound(ctx.since);
    const maps = await buildCommissionMaps(ctx);

    const wm = new WatermarkTracker();
    // page by the watermark expression (ties broken by id) — ascending so checkpoint is monotone
    let cursorWm = since;
    let cursorId = 0;
    for (;;) {
      const [rows] = await ctx.legacy.query<RowDataPacket[]>(
        `SELECT ${COMMISSION_COLS}
           FROM affiliator_commision
          WHERE (COALESCE(\`updated\`, \`created\`) > ?
                 OR (COALESCE(\`updated\`, \`created\`) = ? AND affiliator_commision_id > ?))
          ORDER BY COALESCE(\`updated\`, \`created\`) ASC, affiliator_commision_id ASC
          LIMIT ?`,
        [cursorWm, cursorWm, cursorId, PAGE],
      );
      if ((rows as any[]).length === 0) break;

      // rows are unique by PK (upsert key) → write-independent; checkpoint AFTER the page settles
      await runConcurrent(rows as any[], resyncConfig.writeConcurrency, async (r: any) => {
        stats.scanned += 1;
        if (await applyCommissionRow(ctx, r, maps, stats)) wm.seen(toDate(r.wm));
        else wm.failed(toDate(r.wm));
      });

      const last = (rows as any[])[(rows as any[]).length - 1];
      const lastWm = toDate(last.wm);
      cursorWm = lastWm ?? cursorWm;
      cursorId = Number(last.affiliator_commision_id);
      await ctx.checkpoint(wm.result(ctx.runStart));
      if ((rows as any[]).length < PAGE) break;
    }

    return stats;
  },
};
