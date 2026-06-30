/* eslint-disable no-console */
/**
 * Seed `Product.iosProductId` from the RevenueCat product_id → legacy course_id
 * map (ported from the Supabase edge function's productMap.ts). Bridge:
 *
 *   RC product_id ──map──▶ legacy course_id ──Course.legacyCourseId──▶ Product
 *
 * After this runs, the RevenueCat webhook resolves products purely via
 * `Product.iosProductId` (productRef.bySku) — no hardcoded map in app code.
 *
 * Also seeds `Product.iosPrice` — the gross iOS IAP price (the App Store tier
 * amount, marked up to offset Apple's cut). Mapped manually per SKU below in
 * `RC_TO_IOS_PRICE`. SKUs with no entry (or `0`) are left untouched.
 *
 *   pnpm tsx scripts/seed-revenuecat-iap.ts            (apply)
 *   pnpm tsx scripts/seed-revenuecat-iap.ts --dry-run  (report only)
 *
 * Idempotent: re-running re-applies the same mappings. Skips a SKU already set
 * on another product (unique constraint) and reports it as a conflict.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// RC product_id -> legacy course_id (course.id int). Source of truth for new
// products: add a line here AND ensure the Course row has the legacy_course_id.
const RC_TO_COURSE_ID: Record<string, number> = {
  'com.brainboost.ios.bbbd_consumable': 4857,
  'com.brainboost.ios.bbccp_consumable': 6118,
  'com.brainboost.ios.bbcmv_consumable': 6068,
  'com.brainboost.ios.bbcpv_consumable': 6890,
  'com.brainboost.ios.bbctd_consumable': 7185,
  'com.brainboost.ios.bbfb_consumable': 5901,
  'com.brainboost.ios.bbfpb_consumable': 6411,
  'com.brainboost.ios.bbgc_consumable': 6204,
  'com.brainboost.ios.bblba_consumable': 6332,
  'com.brainboost.ios.bblbg_consumable': 6358,
  'com.brainboost.ios.bblbi_consumable': 6331,
  'com.brainboost.ios.bblbj_consumable': 6356,
  'com.brainboost.ios.bblbk_consumable': 6357,
  'com.brainboost.ios.bblbm_consumable': 6327,
  'com.brainboost.ios.bblgp_consumable': 6119,
  'com.brainboost.ios.bblm_consumable': 5948,
  'com.brainboost.ios.bblvm_consumable': 6025,
  'com.brainboost.ios.bbmcmm_consumable': 6920,
  'com.brainboost.ios.bbmm_consumable': 3867,
  'com.brainboost.ios.bbphi_consumable': 6551,
  'com.brainboost.ios.bbphs_consumable': 6623,
  'com.brainboost.ios.bbpls_consumable': 5946,
  'com.brainboost.ios.bbplspt_consumable': 6404,
  'com.brainboost.ios.bbpps_consumable': 224,
  'com.brainboost.ios.bbpt_consumable': 4896,
  'com.brainboost.ios.bbpz_consumable': 6412,
  'com.brainboost.ios.bbrlx_consumable': 225,
  'com.brainboost.ios.bbsbb_consumable': 4893,
  'com.brainboost.ios.bbsdadk_consumable': 6559,
  'com.brainboost.ios.bbsdank_consumable': 6520,
  'com.brainboost.ios.bbsdayh_consumable': 6482,
  'com.brainboost.ios.bbsdi_consumable': 6522,
  'com.brainboost.ios.bbsdibu_consumable': 6484,
  'com.brainboost.ios.bbsdk_consumable': 6561,
  'com.brainboost.ios.bbsdkakak_consumable': 6560,
  'com.brainboost.ios.bbsdn_consumable': 6523,
  'com.brainboost.ios.bbsds_consumable': 6521,
  'com.brainboost.ios.bbsj_consumable': 5361,
  'com.brainboost.ios.bbsjo_consumable': 6055,
  'com.brainboost.ios.bbska_consumable': 6660,
  'com.brainboost.ios.bbskg_consumable': 6110,
  'com.brainboost.ios.bbskgl_consumable': 6643,
  'com.brainboost.ios.bbsmk_consumable': 6036,
  'com.brainboost.ios.bbspmo_consumable': 6413,
  'com.brainboost.ios.bbssf_consumable': 5705,
  'com.brainboost.ios.bbt1_consumable': 6552,
  'com.brainboost.ios.bbt2_consumable': 6553,
  'com.brainboost.ios.bbt3_consumable': 5866,
  'com.brainboost.ios.bbtale_consumable': 7108,
  'com.brainboost.ios.bbthb_consumable': 7109,
  'com.brainboost.ios.bbthbb_consumable': 7031,
  'com.brainboost.ios.bbtk_consumable': 7179,
  'com.brainboost.ios.bbtn_consumable': 5755,
  'com.brainboost.ios.bbtns_consumable': 6982,
  'com.brainboost.ios.bbts_consumable': 6064,
  'com.brainboost.ios.bbwl_consumable': 5644,
  'com.brainboost.ios.mcpcb_consumable': 7081,
  'com.brainboost.ios.quran_consumable': 7180,
};

// RC product_id -> gross iOS IAP price in IDR (App Store tier amount). Fill in
// the values; SKUs left at 0 (or removed) are skipped — iosPrice stays as-is.
const RC_TO_IOS_PRICE: Record<string, number> = {
  'com.brainboost.ios.bbbd_consumable': 399000,
  'com.brainboost.ios.bbccp_consumable': 399000,
  'com.brainboost.ios.bbcmv_consumable': 399000,
  'com.brainboost.ios.bbcpv_consumable': 399000,
  'com.brainboost.ios.bbctd_consumable': 260000,
  'com.brainboost.ios.bbfb_consumable': 399000,
  'com.brainboost.ios.bbfpb_consumable': 399000,
  'com.brainboost.ios.bbgc_consumable': 399000,
  'com.brainboost.ios.bblba_consumable': 399000,
  'com.brainboost.ios.bblbg_consumable': 399000,
  'com.brainboost.ios.bblbi_consumable': 399000,
  'com.brainboost.ios.bblbj_consumable': 399000,
  'com.brainboost.ios.bblbk_consumable': 399000,
  'com.brainboost.ios.bblbm_consumable': 399000,
  'com.brainboost.ios.bblgp_consumable': 399000,
  'com.brainboost.ios.bblm_consumable': 399000,
  'com.brainboost.ios.bblvm_consumable': 399000,
  'com.brainboost.ios.bbmcmm_consumable': 129000,
  'com.brainboost.ios.bbmm_consumable': 399000,
  'com.brainboost.ios.bbphi_consumable': 399000,
  'com.brainboost.ios.bbphs_consumable': 399000,
  'com.brainboost.ios.bbpls_consumable': 399000,
  'com.brainboost.ios.bbplspt_consumable': 399000,
  'com.brainboost.ios.bbpps_consumable': 399000,
  'com.brainboost.ios.bbpt_consumable': 399000,
  'com.brainboost.ios.bbpz_consumable': 399000,
  'com.brainboost.ios.bbrlx_consumable': 399000,
  'com.brainboost.ios.bbsbb_consumable': 399000,
  'com.brainboost.ios.bbsdadk_consumable': 399000,
  'com.brainboost.ios.bbsdank_consumable': 399000,
  'com.brainboost.ios.bbsdayh_consumable': 399000,
  'com.brainboost.ios.bbsdi_consumable': 399000,
  'com.brainboost.ios.bbsdibu_consumable': 399000,
  'com.brainboost.ios.bbsdk_consumable': 399000,
  'com.brainboost.ios.bbsdkakak_consumable': 399000,
  'com.brainboost.ios.bbsdn_consumable': 399000,
  'com.brainboost.ios.bbsds_consumable': 399000,
  'com.brainboost.ios.bbsj_consumable': 399000,
  'com.brainboost.ios.bbsjo_consumable': 399000,
  'com.brainboost.ios.bbska_consumable': 399000,
  'com.brainboost.ios.bbskg_consumable': 399000,
  'com.brainboost.ios.bbskgl_consumable': 399000,
  'com.brainboost.ios.bbsmk_consumable': 399000,
  'com.brainboost.ios.bbspmo_consumable': 399000,
  'com.brainboost.ios.bbssf_consumable': 399000,
  'com.brainboost.ios.bbt1_consumable': 399000,
  'com.brainboost.ios.bbt2_consumable': 399000,
  'com.brainboost.ios.bbt3_consumable': 399000,
  'com.brainboost.ios.bbtale_consumable': 520000,
  'com.brainboost.ios.bbthb_consumable': 399000,
  'com.brainboost.ios.bbthbb_consumable': 399000,
  'com.brainboost.ios.bbtk_consumable': 399000,
  'com.brainboost.ios.bbtn_consumable': 399000,
  'com.brainboost.ios.bbtns_consumable': 399000,
  'com.brainboost.ios.bbts_consumable': 399000,
  'com.brainboost.ios.bbwl_consumable': 399000,
  'com.brainboost.ios.mcpcb_consumable': 129000,
  'com.brainboost.ios.quran_consumable': 399000,
};

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(
    `[seed-rc-iap] ${dryRun ? 'DRY RUN — ' : ''}${Object.keys(RC_TO_COURSE_ID).length} mappings`,
  );

  let applied = 0;
  let alreadySet = 0;
  let priceApplied = 0;
  let priceAlreadySet = 0;
  const missing: { sku: string; courseId: number }[] = [];
  const conflicts: { sku: string; reason: string }[] = [];

  for (const [sku, legacyCourseId] of Object.entries(RC_TO_COURSE_ID)) {
    const course = await prisma.course.findUnique({
      where: { legacyCourseId },
      select: {
        product: { select: { id: true, iosProductId: true, iosPrice: true } },
      },
    });
    if (!course) {
      missing.push({ sku, courseId: legacyCourseId });
      continue;
    }
    const product = course.product;

    // Seed iosPrice from the manual map, independently of the iosProductId
    // mapping below — a SKU/course mismatch shouldn't block the price. A SKU
    // with no entry (or 0) is left untouched.
    const desiredIosPrice = RC_TO_IOS_PRICE[sku];
    if (desiredIosPrice && product.iosPrice !== desiredIosPrice) {
      if (!dryRun) {
        await prisma.product.update({
          where: { id: product.id },
          data: { iosPrice: desiredIosPrice },
        });
      }
      priceApplied++;
      console.log(
        `  ${dryRun ? 'would set' : 'set'} iosPrice ${product.iosPrice ?? '∅'} → ${desiredIosPrice} on product ${product.id} (course ${legacyCourseId})`,
      );
    } else if (desiredIosPrice) {
      priceAlreadySet++;
    }

    if (product.iosProductId === sku) {
      alreadySet++;
      continue;
    }
    if (product.iosProductId && product.iosProductId !== sku) {
      conflicts.push({
        sku,
        reason: `product ${product.id} already has iosProductId=${product.iosProductId}`,
      });
      continue;
    }

    // Guard the unique constraint: SKU may already sit on a different product.
    const taken = await prisma.product.findUnique({
      where: { iosProductId: sku },
      select: { id: true },
    });
    if (taken && taken.id !== product.id) {
      conflicts.push({ sku, reason: `SKU already on product ${taken.id}` });
      continue;
    }

    if (!dryRun) {
      await prisma.product.update({ where: { id: product.id }, data: { iosProductId: sku } });
    }
    applied++;
    console.log(
      `  ${dryRun ? 'would set' : 'set'} ${sku} → product ${product.id} (course ${legacyCourseId})`,
    );
  }

  console.log('\n[seed-rc-iap] summary');
  console.log(`  applied:        ${applied}`);
  console.log(`  alreadySet:     ${alreadySet}`);
  console.log(`  priceApplied:   ${priceApplied}`);
  console.log(`  priceAlreadySet:${priceAlreadySet}`);
  console.log(`  missing:        ${missing.length}`);
  console.log(`  conflicts:      ${conflicts.length}`);
  if (missing.length) {
    console.log(
      '\n  MISSING (no Course with that legacy_course_id — backfill course legacyCourseId first):',
    );
    for (const m of missing) console.log(`    ${m.sku} → course ${m.courseId}`);
  }
  if (conflicts.length) {
    console.log('\n  CONFLICTS (resolve manually):');
    for (const c of conflicts) console.log(`    ${c.sku}: ${c.reason}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
