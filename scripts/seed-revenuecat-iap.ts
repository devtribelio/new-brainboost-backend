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
  'com.brainboost.ios.bbmm_lifetime': 3867,
  'com.brainboost.ios.bbrlx_lifetime': 225,
  'com.brainboost.ios.bbsbb_lifetime': 4893,
  'com.brainboost.ios.bbbd_lifetime': 4857,
  'com.brainboost.ios.bbpps_lifetime': 224,
  'com.brainboost.ios.bblm_lifetime': 5948,
  'com.brainboost.ios.bbfb_lifetime': 5901,
  'com.brainboost.ios.bblvm_lifetime': 6025,
  'com.brainboost.ios.bbpls_lifetime': 5946,
  'com.brainboost.ios.bbssf_lifetime': 5705,
  'com.brainboost.ios.bbsj_lifetime': 5361,
  'com.brainboost.ios.bbwl_lifetime': 5644,
  'com.brainboost.ios.bbtn_lifetime': 5755,
  'com.brainboost.ios.bbsmk_lifetime': 6036,
  'com.brainboost.ios.bbts_lifetime': 6064,
  'com.brainboost.ios.bblgp_lifetime': 6119,
  'com.brainboost.ios.bbskg_lifetime': 6110,
  'com.brainboost.ios.bbccp_lifetime': 6118,
  'com.brainboost.ios.bbgc_lifetime': 6204,
  'com.brainboost.ios.bblba_lifetime': 6332,
  'com.brainboost.ios.bblbi_lifetime': 6331,
  'com.brainboost.ios.bblbm_lifetime': 6327,
  'com.brainboost.ios.bblbj_lifetime': 6356,
  'com.brainboost.ios.bblbk_lifetime': 6357,
  'com.brainboost.ios.bblbg_lifetime': 6358,
  'com.brainboost.ios.bbplspt_lifetime': 6404,
  'com.brainboost.ios.bbfpb_lifetime': 6411,
  'com.brainboost.ios.bbpz_lifetime': 6412,
  'com.brainboost.ios.bbsdayh_lifetime': 6482,
  'com.brainboost.ios.bbsdibu_lifetime': 6484,
  'com.brainboost.ios.bbsdank_lifetime': 6520,
  'com.brainboost.ios.bbsds_lifetime': 6521,
  'com.brainboost.ios.bbsdi_lifetime': 6522,
  'com.brainboost.ios.bbsdn_lifetime': 6523,
  'com.brainboost.ios.bbphi_lifetime': 6551,
  'com.brainboost.ios.bbtns_lifetime': 6982,
  'com.brainboost.ios.bbthbb_lifetime': 7031,
  'com.brainboost.ios.bbthb_lifetime': 7109,
  'com.brainboost.ios.bbtk_lifetime': 7179,
  'com.brainboost.ios.quran_lifetime': 7180,
  'com.brainboost.ios.bbpt_lifetime': 4896,
  'com.brainboost.ios.bbt1_lifetime': 6552,
  'com.brainboost.ios.bbt2_lifetime': 6553,
  'com.brainboost.ios.bbsdadk_lifetime': 6559,
  'com.brainboost.ios.bsdkk_lifetime': 6560,
  'com.brainboost.ios.bbsdk_lifetime': 6561,
  'com.brainboost.ios.bbphs_lifetime': 6623,
  'com.brainboost.ios.bbskgl_lifetime': 6643,
  'com.brainboost.ios.bbska_lifetime': 6660,
  'com.brainboost.ios.bbt3_lifetime': 5866,
  'com.brainboost.ios.bbsjo_lifetime': 6055,
  'com.brainboost.ios.bbcmv_lifetime': 6068,
  'com.brainboost.ios.bbspmo_lifetime': 6413,
  'com.brainboost.ios.bbcpv_lifetime': 6890,
};

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`[seed-rc-iap] ${dryRun ? 'DRY RUN — ' : ''}${Object.keys(RC_TO_COURSE_ID).length} mappings`);

  let applied = 0;
  let alreadySet = 0;
  const missing: { sku: string; courseId: number }[] = [];
  const conflicts: { sku: string; reason: string }[] = [];

  for (const [sku, legacyCourseId] of Object.entries(RC_TO_COURSE_ID)) {
    const course = await prisma.course.findUnique({
      where: { legacyCourseId },
      select: { product: { select: { id: true, iosProductId: true } } },
    });
    if (!course) {
      missing.push({ sku, courseId: legacyCourseId });
      continue;
    }
    const product = course.product;
    if (product.iosProductId === sku) {
      alreadySet++;
      continue;
    }
    if (product.iosProductId && product.iosProductId !== sku) {
      conflicts.push({ sku, reason: `product ${product.id} already has iosProductId=${product.iosProductId}` });
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
    console.log(`  ${dryRun ? 'would set' : 'set'} ${sku} → product ${product.id} (course ${legacyCourseId})`);
  }

  console.log('\n[seed-rc-iap] summary');
  console.log(`  applied:     ${applied}`);
  console.log(`  alreadySet:  ${alreadySet}`);
  console.log(`  missing:     ${missing.length}`);
  console.log(`  conflicts:   ${conflicts.length}`);
  if (missing.length) {
    console.log('\n  MISSING (no Course with that legacy_course_id — backfill course legacyCourseId first):');
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
