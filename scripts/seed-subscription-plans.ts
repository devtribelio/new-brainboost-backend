/* eslint-disable no-console */
/**
 * Seed the 4 annual subscription Products + SubscriptionPlans (Phase 1).
 * Idempotent — an existing row (matched by unique code) is NEVER touched:
 * operators may have tuned Product.price or plan rates at runtime (e.g. the
 * final renewalAffiliateRate once the COO decides), and a re-run must not
 * revert that. See docs/prd-subscription-backend.md (BE-02).
 *
 *   pnpm seed:subscription-plans            (apply)
 *   pnpm seed:subscription-plans --dry-run  (report only)
 *
 * SKUs are placeholders until the App Store / Play Store auto-renewing
 * products exist (PRD §5 external dependency) — update the Product rows with
 * the real SKUs then. The 2 runtime settings (subscription.graceDays /
 * subscription.reminderDaysBefore) are seeded by `pnpm seed:settings`.
 *
 * ⚠️ Prod sequencing: do NOT run on prod before BE-11 is live — course lists
 * don't exclude type='subscription' yet, so these would surface in the app
 * catalog as broken course cards.
 */
import type { PrismaClient } from '@prisma/client';

export interface SubscriptionPlanSeed {
  productCode: string;
  planCode: string;
  tier: string;
  title: string;
  price: number;
  seatCount: number;
  sortOrder: number;
  iosProductId: string;
  androidProductId: string;
}

const PERIOD_MONTHS = 12;
const AFFILIATE_RATE = 40; // % flat L1, first sale (PRD locked)
const RENEWAL_AFFILIATE_RATE = 20; // % placeholder — final number pending COO

export const PLAN_SEEDS: SubscriptionPlanSeed[] = [
  {
    productCode: 'SUB-SOLO-12M',
    planCode: 'SOLO_12M',
    tier: 'SOLO',
    title: 'BrainBoost Solo — Langganan 1 Tahun (1 device)',
    price: 999_000,
    seatCount: 1,
    sortOrder: 1,
    iosProductId: 'com.brainboost.ios.sub_solo_annual',
    androidProductId: 'com.brainboost.android.sub_solo_annual',
  },
  {
    productCode: 'SUB-DUO-12M',
    planCode: 'DUO_12M',
    tier: 'DUO',
    title: 'BrainBoost Duo — Langganan 1 Tahun (2 device)',
    price: 1_499_000,
    seatCount: 2,
    sortOrder: 2,
    iosProductId: 'com.brainboost.ios.sub_duo_annual',
    androidProductId: 'com.brainboost.android.sub_duo_annual',
  },
  {
    productCode: 'SUB-FAMILY-12M',
    planCode: 'FAMILY_12M',
    tier: 'FAMILY',
    title: 'BrainBoost Family — Langganan 1 Tahun (4 device)',
    price: 1_999_000,
    seatCount: 4,
    sortOrder: 3,
    iosProductId: 'com.brainboost.ios.sub_family_annual',
    androidProductId: 'com.brainboost.android.sub_family_annual',
  },
  {
    productCode: 'SUB-PREMIUM-12M',
    planCode: 'PREMIUM_12M',
    tier: 'PREMIUM',
    title: 'BrainBoost Premium — Langganan 1 Tahun (6 device)',
    price: 2_799_000,
    seatCount: 6,
    sortOrder: 4,
    iosProductId: 'com.brainboost.ios.sub_premium_annual',
    androidProductId: 'com.brainboost.android.sub_premium_annual',
  },
];

export interface SeedStats {
  productsCreated: number;
  productsSkipped: number;
  plansCreated: number;
  plansSkipped: number;
}

export async function seedSubscriptionPlans(
  prisma: PrismaClient,
  opts: { dryRun?: boolean } = {},
): Promise<SeedStats> {
  const dryRun = opts.dryRun ?? false;
  const stats: SeedStats = {
    productsCreated: 0,
    productsSkipped: 0,
    plansCreated: 0,
    plansSkipped: 0,
  };

  for (const seed of PLAN_SEEDS) {
    let product = await prisma.product.findUnique({ where: { code: seed.productCode } });
    if (product) {
      stats.productsSkipped++;
      console.log(`  product ${seed.productCode} exists — untouched`);
    } else {
      stats.productsCreated++;
      console.log(
        `  ${dryRun ? 'would create' : 'create'} product ${seed.productCode} (${seed.price} IDR)`,
      );
      if (!dryRun) {
        product = await prisma.product.create({
          data: {
            type: 'subscription',
            code: seed.productCode,
            title: seed.title,
            price: seed.price,
            status: 'active',
            isActive: true,
            iosProductId: seed.iosProductId,
            androidProductId: seed.androidProductId,
          },
        });
      }
    }

    const plan = await prisma.subscriptionPlan.findUnique({ where: { code: seed.planCode } });
    if (plan) {
      stats.plansSkipped++;
      console.log(`  plan ${seed.planCode} exists — untouched`);
      continue;
    }
    stats.plansCreated++;
    console.log(
      `  ${dryRun ? 'would create' : 'create'} plan ${seed.planCode} (${seed.seatCount} seat, L1 ${AFFILIATE_RATE}%/renewal ${RENEWAL_AFFILIATE_RATE}%)`,
    );
    if (!dryRun) {
      if (!product) throw new Error(`product ${seed.productCode} missing after create`); // unreachable
      await prisma.subscriptionPlan.create({
        data: {
          productId: product.id,
          code: seed.planCode,
          tier: seed.tier,
          periodMonths: PERIOD_MONTHS,
          seatCount: seed.seatCount,
          affiliateRate: AFFILIATE_RATE,
          renewalAffiliateRate: RENEWAL_AFFILIATE_RATE,
          isActive: true,
          sortOrder: seed.sortOrder,
        },
      });
    }
  }

  return stats;
}

/* c8 ignore start */
// CLI entry — the spec imports seedSubscriptionPlans directly.
if (process.argv[1]?.endsWith('seed-subscription-plans.ts')) {
  void (async () => {
    const { PrismaClient } = await import('@prisma/client');
    await import('dotenv/config');
    const prisma = new PrismaClient();
    const dryRun = process.argv.includes('--dry-run');
    console.log(`[seed-subscription-plans] ${dryRun ? 'DRY RUN' : 'apply'}`);
    try {
      const stats = await seedSubscriptionPlans(prisma, { dryRun });
      console.log('\n[seed-subscription-plans] summary');
      console.log(`  products: ${stats.productsCreated} created, ${stats.productsSkipped} skipped`);
      console.log(`  plans:    ${stats.plansCreated} created, ${stats.plansSkipped} skipped`);
    } catch (e) {
      console.error(e);
      process.exitCode = 1;
    } finally {
      await prisma.$disconnect();
    }
  })();
}
/* c8 ignore stop */
