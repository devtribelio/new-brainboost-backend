/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * Migrate legacy affiliate commissions -> AffiliateCommission (for lifetime/tier + history).
 *
 *   pnpm tsx scripts/migrate-affiliate-commissions.ts [--dry-run]
 *
 * WHY (docs/specs/member-migration-plan.md): `currentTier`/`currentRate` in /affiliate/me/summary
 * are derived from `lifetimeAmount = SUM(AffiliateCommission.amount WHERE status != VOIDED
 * AND affiliateBased != INACTIVE)`. Without commissions every member is Tier 1.
 *
 * KEY: migrated rows get status **MIGRATED** (not BALANCE) so they:
 *   - COUNT toward lifetime/tier  (status != VOIDED)
 *   - do NOT inflate withdrawable balance (status != BALANCE)  ← legacy balance stays 0
 *   - are never promoted by the PENDING->BALANCE cron (status != PENDING)
 * Expired legacy rows (is_expired=1) -> VOIDED (legacy `getPerformanceSchemaPercent` excludes
 * them via is_expired=0). New post-migration purchases use the normal PENDING->BALANCE flow.
 *
 * Non-brainboost products are NOT inserted: productId/programId are left null (nullable FKs).
 * paymentLegacyId stores the legacy payment id without a FK. Scoped to migrated members,
 * redirect-aware. Run AFTER migrate:members + backfill:affiliate-program-product.
 * Idempotent: keyed legacyId = affiliator_commision_id.
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import type { RowDataPacket } from 'mysql2/promise';
import { PrismaClient } from '@prisma/client';
import { connectLegacyDb } from './legacy-db';

const REDIRECT_PATH = 'scripts/member-redirect.json';
const PAGE = 5000;
const INSERT_CHUNK = 1000;
const BASED = new Set(['PERFORMANCE', 'GROWTH', 'INACTIVE']);

const prisma = new PrismaClient({ log: ['warn', 'error'] });
const dryRun = process.argv.includes('--dry-run');

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [migrate-aff-commissions] ${msg}`);
}
function intOf(v: any): number {
  return Math.round(Number(v ?? 0)) || 0;
}
function toDate(v: any): Date {
  if (!v) return new Date();
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}
function loadRedirect(): Map<number, number> {
  const m = new Map<number, number>();
  if (!existsSync(REDIRECT_PATH)) return m;
  const raw = JSON.parse(readFileSync(REDIRECT_PATH, 'utf8')) as Record<string, number>;
  for (const [l, w] of Object.entries(raw)) m.set(Number(l), Number(w));
  return m;
}

async function main() {
  if (dryRun) log('DRY RUN — no writes');
  const redirect = loadRedirect();
  log(`redirect map: ${redirect.size}`);

  // legacy member_id -> new Member.id (redirect a loser to its winner before lookup)
  const members = await prisma.member.findMany({
    where: { legacyId: { not: null } },
    select: { id: true, legacyId: true },
  });
  const memberByLegacy = new Map<number, string>();
  for (const m of members) if (m.legacyId !== null) memberByLegacy.set(m.legacyId, m.id);
  const resolveMember = (legacyId: number | null | undefined): string | null => {
    if (legacyId == null) return null;
    const canonical = redirect.get(legacyId) ?? legacyId;
    return memberByLegacy.get(canonical) ?? null;
  };
  log(`members: ${memberByLegacy.size}`);

  // brainboost course product: legacyId(course_id) -> Product.id (for productId link)
  const products = await prisma.product.findMany({
    where: { type: 'course', legacyId: { not: null } },
    select: { id: true, legacyId: true },
  });
  const productByCourse = new Map<number, string>();
  for (const p of products) if (p.legacyId !== null) productByCourse.set(p.legacyId, p.id);

  // AffiliateProgram: legacyId(napa_id) -> id
  const programs = await prisma.affiliateProgram.findMany({
    where: { legacyId: { not: null } },
    select: { id: true, legacyId: true },
  });
  const programByNapa = new Map<number, string>();
  for (const g of programs) if (g.legacyId !== null) programByNapa.set(g.legacyId, g.id);
  log(`brainboost products: ${productByCourse.size}, programs: ${programByNapa.size}`);

  const legacy = await connectLegacyDb({ dateStrings: false });
  log('connected to legacy mariadb');

  let scanned = 0;
  let prepared = 0;
  let inserted = 0;
  let skipNoRecipient = 0;
  let cursor = 0;
  const buffer: any[] = [];

  const flush = async () => {
    if (dryRun || buffer.length === 0) {
      buffer.length = 0;
      return;
    }
    for (let i = 0; i < buffer.length; i += INSERT_CHUNK) {
      const res = await prisma.affiliateCommission.createMany({
        data: buffer.slice(i, i + INSERT_CHUNK),
        skipDuplicates: true,
      });
      inserted += res.count;
    }
    buffer.length = 0;
  };

  try {
    for (;;) {
      const [rows] = await legacy.query<RowDataPacket[]>(
        `SELECT affiliator_commision_id, member_recipient_id, member_downline_id, level,
                payment_id, product_model, product_id, network_account_product_affiliator_id,
                product_price, commision_amount, price_recipient, affiliate_based,
                is_expired, created
           FROM affiliator_commision
          WHERE affiliator_commision_id > ?
          ORDER BY affiliator_commision_id ASC
          LIMIT ?`,
        [cursor, PAGE],
      );
      if (rows.length === 0) break;
      cursor = Number((rows[rows.length - 1] as any).affiliator_commision_id);

      for (const r of rows as any[]) {
        scanned++;
        const recipientId = resolveMember(Number(r.member_recipient_id));
        if (!recipientId) {
          skipNoRecipient++; // recipient not in migrated scope
          continue;
        }
        const isCourse =
          typeof r.product_model === 'string' && r.product_model.includes('Course');
        const productId = isCourse ? productByCourse.get(Number(r.product_id)) ?? null : null;
        const programId = programByNapa.get(Number(r.network_account_product_affiliator_id)) ?? null;
        const based = BASED.has(String(r.affiliate_based)) ? String(r.affiliate_based) : 'PERFORMANCE';

        buffer.push({
          legacyId: Number(r.affiliator_commision_id),
          recipientId,
          buyerMemberId: resolveMember(Number(r.member_downline_id)),
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
          // Expired legacy commissions are excluded from lifetime (legacy is_expired=0);
          // everything else is MIGRATED — counts for tier, not for balance.
          status: Number(r.is_expired) === 1 ? 'VOIDED' : 'MIGRATED',
          createdAt: toDate(r.created),
        });
        prepared++;
      }
      if (buffer.length >= INSERT_CHUNK) await flush();
      if (scanned % 20000 === 0) log(`scanned=${scanned} prepared=${prepared} inserted=${inserted}`);
    }
    await flush();
  } finally {
    await legacy.end();
    await prisma.$disconnect();
  }

  log(
    `DONE${dryRun ? ' (dry-run)' : ''} scanned=${scanned} prepared=${prepared} ` +
      `inserted=${dryRun ? '(dry)' : inserted} skipNoRecipient=${skipNoRecipient}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
