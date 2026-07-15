/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Commissions syncer — incremental port of migrate-affiliate-commissions.ts.
 *
 * SOURCE legacy affiliator_commision.
 * STATUS legacy rows → MIGRATED (count toward lifetime/tier, not balance); is_expired=1
 *        → VOIDED (excluded from lifetime). Both ride the `updated` watermark.
 * GUARD  upsert keyed legacyId — new Xendit commissions have legacyId=null, so this never
 *        touches PENDING/BALANCE/VOIDED rows owned by the new flow.
 * See docs/specs/legacy-resync-plan.md §6.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { resyncConfig } from '../config';
import { emptyStats, type RunCtx, type Stats, type Syncer, type SyncerCtx } from '../types';
import { maxWatermark, runConcurrent, sinceBound, toDate } from '../util';

const BASED = new Set(['PERFORMANCE', 'GROWTH', 'INACTIVE']);
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
    where: { type: 'course', legacyId: { not: null } },
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

/** Process one legacy affiliator_commision row (resolve + upsert). Shared with backfill. */
export async function applyCommissionRow(ctx: RunCtx, r: any, maps: CommissionMaps, stats: Stats): Promise<void> {
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
    stats.skipped += 1;
    return;
  }
  if (ctx.dryRun) {
    stats.upserted += 1;
    if (Number(r.is_expired) === 1) stats.voided = (stats.voided ?? 0) + 1;
    return;
  }
  const programId = maps.programByNapa.get(Number(r.network_account_product_affiliator_id)) ?? null;
  const based = BASED.has(String(r.affiliate_based)) ? String(r.affiliate_based) : 'PERFORMANCE';
  const status = Number(r.is_expired) === 1 ? 'VOIDED' : 'MIGRATED';

  const fields = {
    recipientId,
    buyerMemberId: ctx.resolveMember(Number(r.member_downline_id)) ?? null,
    programId,
    productId,
    paymentId: null,
    paymentLegacyId: r.payment_id != null ? Number(r.payment_id) : null,
    level: intOf(r.level) || 1,
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
      // only the legacy-owned fields; never demote a non-legacy row (no collision anyway)
      update: { status: fields.status, amount: fields.amount, commissionRate: fields.commissionRate },
    });
    stats.upserted += 1;
    if (status === 'VOIDED') stats.voided = (stats.voided ?? 0) + 1;
  } catch (err: any) {
    if (err?.code === 'P2002') stats.skipped += 1; // uniq(payment,recipient,level) clash
    else stats.errors += 1;
  }
}

export const COMMISSION_COLS = `affiliator_commision_id, member_recipient_id, member_downline_id, level,
                payment_id, product_model, product_id, network_account_product_affiliator_id,
                product_price, commision_amount, price_recipient, affiliate_based,
                is_expired, created, COALESCE(\`updated\`, \`created\`) AS wm`;

export const commissionsSyncer: Syncer = {
  name: 'commissions',
  async run(ctx: SyncerCtx): Promise<Stats> {
    const stats = emptyStats();
    const since = sinceBound(ctx.since);
    const maps = await buildCommissionMaps(ctx);

    let watermark = ctx.since;
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
        watermark = maxWatermark(watermark, toDate(r.wm));
        await applyCommissionRow(ctx, r, maps, stats);
      });

      const last = (rows as any[])[(rows as any[]).length - 1];
      const lastWm = toDate(last.wm);
      cursorWm = lastWm ?? cursorWm;
      cursorId = Number(last.affiliator_commision_id);
      if (watermark && !ctx.dryRun) await ctx.checkpoint(watermark);
      if ((rows as any[]).length < PAGE) break;
    }

    return stats;
  },
};
