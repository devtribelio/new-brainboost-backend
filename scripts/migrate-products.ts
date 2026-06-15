import 'dotenv/config';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { PrismaClient, Prisma } from '@prisma/client';
import { connectLegacyDb } from './legacy-db';

/**
 * One-shot: enrich EXISTING new-Postgres Products with their legacy `course` data
 * and a linked `Course` row, so course_enrollment can be granted on payment.
 *
 *   pnpm tsx scripts/migrate-products.ts [--dry-run]
 *
 * MODEL NOTE
 * ----------
 * In legacy there is ONE entity — the `course` row (the BrainBoost catalog lives
 * under `course.client = 'brainboost'`). The new schema splits that single row into
 * Product (the sellable side) + Course (the learnable side, anchor for sections /
 * lessons / enrollment), 1:1. This script fills BOTH halves from the one legacy row.
 *
 * The legacy `product` table is UNRELATED — it is an abandoned physical-goods
 * marketplace (stock/weight/courier, junk test data). Do NOT source products from it.
 *
 * BRIDGE = `code`
 * ---------------
 * Products already exist in the new DB (created by the app) and carry the legacy
 * `course.code`. We match `Product.code == course.code` (NOT legacyId — the app did
 * not populate legacyId for these). Only matched products are enriched; this script
 * NEVER inserts a new Product, so it cannot bloat the catalog.
 *
 * Per matched product: set type='course', legacyId = course_id, copy course fields,
 * then upsert Course(productId, legacyCourseId = course_id).
 *
 * Idempotent: updates by id, upserts Course by productId. Safe to re-run.
 *
 * Run order:  migrate-products  ->  migrate-course-sections  ->  migrate-course-lessons
 * (backfill:course-legacy-id becomes a no-op — legacyCourseId is set here directly.)
 */

const CLIENT = 'brainboost';

const prisma = new PrismaClient({ log: ['warn', 'error'] });

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  // eslint-disable-next-line no-console
  console.log(`[${ts}] [migrate-products] ${msg}`);
}

function nonEmpty(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length > 0 ? str : null;
}

/** legacy `selling_point` is a JSON string[] (legacy stores it serialized). */
function parseSellingPoints(raw: unknown): Prisma.InputJsonValue | undefined {
  const v = nonEmpty(raw);
  if (v === null) return undefined;
  try {
    return JSON.parse(v) as Prisma.InputJsonValue;
  } catch {
    // Not JSON — fall back to a single-element list so the value isn't lost.
    return [v];
  }
}

interface LegacyCourseRow extends RowDataPacket {
  course_id: number;
  code: string | null;
  slug: string | null;
  title: string | null;
  description: string | null;
  price: number | string | null;
  tags: string | null;
  selling_point: string | null;
  marketing_link: string | null;
}

/** Pull the BrainBoost catalog from legacy — the only `client` we migrate. */
async function fetchBrainboostCourses(legacy: Connection): Promise<LegacyCourseRow[]> {
  const [rows] = await legacy.query<LegacyCourseRow[]>(
    `SELECT course_id, code, slug, title, description, price, tags, selling_point, marketing_link
       FROM course
      WHERE client = ?
        AND course_status = 'PUBLISH'
        AND status = 1
        AND code IS NOT NULL`,
    [CLIENT],
  );
  return rows;
}

/** Existing Product code -> id, so we can bridge legacy course.code -> Product. */
async function loadProductByCode(): Promise<Map<string, string>> {
  const rows = await prisma.product.findMany({
    where: { code: { not: null } },
    select: { id: true, code: true },
  });
  const map = new Map<string, string>();
  for (const r of rows) if (r.code) map.set(r.code, r.id);
  return map;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) log('DRY RUN — no writes to Postgres');

  const productByCode = await loadProductByCode();
  log(`existing products with code: ${productByCode.size}`);

  const legacy = await connectLegacyDb({ dateStrings: false });
  log('connected to legacy mariadb');

  let matched = 0;
  let updated = 0;
  let courses = 0;
  const unmatched: { courseId: number; code: string }[] = [];

  try {
    const rows = await fetchBrainboostCourses(legacy);
    log(`brainboost published courses: ${rows.length}`);

    for (const r of rows) {
      const courseId = Number(r.course_id);
      const code = nonEmpty(r.code);
      if (!code) continue;

      const productId = productByCode.get(code);
      if (!productId) {
        unmatched.push({ courseId, code });
        continue; // skip + log: never insert a new Product
      }
      matched++;

      const title = nonEmpty(r.title);
      const sellingPoints = parseSellingPoints(r.selling_point);
      const price = Math.round(Number(r.price ?? 0)) || 0;

      if (dryRun) {
        if (matched <= 3) {
          log(
            `sample code=${code} course_id=${courseId} product=${productId} -> ` +
              `type=course, title=${title?.slice(0, 40)}, price=${price}, sp=${JSON.stringify(sellingPoints)}`,
          );
        }
        continue;
      }

      // Enrich the EXISTING product in place (never insert).
      await prisma.product.update({
        where: { id: productId },
        data: {
          type: 'course',
          legacyId: courseId,
          slug: nonEmpty(r.slug),
          ...(title ? { title } : {}),
          description: nonEmpty(r.description),
          price,
          marketingLink: nonEmpty(r.marketing_link),
          sellingPoints,
          tags: nonEmpty(r.tags),
        },
      });
      updated++;

      // Create/link the learnable half (Course) — anchor for sections/lessons/enrollment.
      await prisma.course.upsert({
        where: { productId },
        create: { productId, legacyCourseId: courseId },
        update: { legacyCourseId: courseId },
      });
      courses++;
    }
  } finally {
    await legacy.end();
    await prisma.$disconnect();
  }

  if (unmatched.length) {
    log(`UNMATCHED (no Product with that code, skipped): ${unmatched.length}`);
    for (const u of unmatched.slice(0, 20)) log(`  - course_id=${u.courseId} code=${u.code}`);
    if (unmatched.length > 20) log(`  ... +${unmatched.length - 20} more`);
  }

  log(
    `DONE${dryRun ? ' (dry-run, no writes)' : ''} ` +
      `matched=${matched} productsUpdated=${updated} coursesLinked=${courses} unmatched=${unmatched.length}`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
