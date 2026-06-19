import 'dotenv/config';
import type { RowDataPacket } from 'mysql2/promise';
import { PrismaClient } from '@prisma/client';
import { connectLegacyDb } from './legacy-db';

/**
 * Link each course AffiliateProgram to its Product and activate it.
 *
 *   pnpm tsx scripts/backfill-affiliate-program-product.ts [--dry-run]
 *
 * WHY THIS EXISTS
 * ---------------
 * `migrate-from-legacy.ts::migrateAffiliatePrograms` only set `productId` when the
 * legacy `network_account_product_affiliator.productable` string contained "product".
 * Course programs carry `productable = 'TBModel_Course'`, so every course program
 * migrated with `productId = NULL` (and `isActive = false`, mirroring legacy
 * `is_active = 0`). Result: a brainboost course purchase resolves no `programId`, and
 * `commitCommissionsForPayment` early-returns "no programId → skip" — affiliate
 * commissions never fire.
 *
 * This backfill rebuilds the program→product link for COURSE programs and activates
 * them, using the keys already migrated:
 *   legacy napa.network_account_product_affiliator_id == AffiliateProgram.legacyId
 *   legacy napa.productable_id (= course_id)          == Product.legacyId  (type='course')
 *
 * Scope: only course programs whose matching course-Product already exists in the new
 * DB (today that is the 58 brainboost courses). Idempotent — updates by id, safe re-run.
 */

const ACTIVATE = true; // legacy is_active=0 for all; new system wants brainboost affiliate ON.

const prisma = new PrismaClient({ log: ['warn', 'error'] });

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  // eslint-disable-next-line no-console
  console.log(`[${ts}] [backfill-aff-program] ${msg}`);
}

interface NapaRow extends RowDataPacket {
  napa_id: number;
  course_id: number;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) log('DRY RUN — no writes to Postgres');

  const legacy = await connectLegacyDb({ dateStrings: false });
  log('connected to legacy mariadb');

  let linked = 0;
  let activated = 0;
  let noProduct = 0;
  let noProgram = 0;
  let sampled = 0;

  try {
    // Legacy course programs: program id -> course id.
    const [rows] = await legacy.query<NapaRow[]>(
      `SELECT network_account_product_affiliator_id AS napa_id, productable_id AS course_id
         FROM network_account_product_affiliator
        WHERE productable LIKE '%Course%' AND productable_id IS NOT NULL`,
    );
    log(`legacy course programs: ${rows.length}`);

    // Existing course-Product: legacyId(course_id) -> product.id
    const products = await prisma.product.findMany({
      where: { type: 'course', legacyId: { not: null } },
      select: { id: true, legacyId: true },
    });
    const productByCourseId = new Map<number, string>();
    for (const p of products) if (p.legacyId !== null) productByCourseId.set(p.legacyId, p.id);
    log(`existing course products: ${productByCourseId.size}`);

    // Existing programs by legacyId(napa_id) -> program id
    const programs = await prisma.affiliateProgram.findMany({
      where: { legacyId: { not: null } },
      select: { id: true, legacyId: true },
    });
    const programByNapaId = new Map<number, string>();
    for (const g of programs) if (g.legacyId !== null) programByNapaId.set(g.legacyId, g.id);

    for (const r of rows) {
      const napaId = Number(r.napa_id);
      const courseId = Number(r.course_id);

      const productId = productByCourseId.get(courseId);
      if (!productId) {
        noProduct++; // course program whose product isn't in the new DB (non-brainboost) — skip
        continue;
      }
      const programId = programByNapaId.get(napaId);
      if (!programId) {
        noProgram++;
        continue;
      }

      if (dryRun) {
        linked++;
        if (sampled < 3) {
          sampled++;
          log(`sample napa=${napaId} course=${courseId} -> program=${programId} product=${productId} (isActive=${ACTIVATE})`);
        }
        continue;
      }

      await prisma.affiliateProgram.update({
        where: { id: programId },
        data: { productId, ...(ACTIVATE ? { isActive: true } : {}) },
      });
      linked++;
      if (ACTIVATE) activated++;
    }
  } finally {
    await legacy.end();
    await prisma.$disconnect();
  }

  log(
    `DONE${dryRun ? ' (dry-run, no writes)' : ''} ` +
      `linked=${linked} activated=${activated} skippedNoProduct=${noProduct} skippedNoProgram=${noProgram}`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
