import 'dotenv/config';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { PrismaClient, Prisma } from '@prisma/client';
import { connectLegacyDb } from './legacy-db';

/**
 * One-shot: enrich EXISTING new-Postgres Products with their legacy `course` data
 * and a linked `Course` row, so course_enrollment can be granted on payment.
 *
 *   pnpm tsx scripts/migrate-courses.ts [--dry-run]
 *
 * WHY THIS EXISTS
 * ---------------
 * `grantCourseEnrollment` short-circuits unless a Product is `type='course'` AND has a
 * linked `Course` row. Products already exist in the new DB (created by the app /
 * earlier import), but many lacked `type='course'` and/or a `Course`, so enrollment was
 * never written on a successful payment.
 *
 * SCOPE (important): this is driven by the EXISTING products in the new DB, NOT by the
 * full legacy `course` catalog. We iterate every Product that has a `legacyId`, look up
 * the matching legacy `course` row by `course_id == Product.legacyId`, and only then set
 * `type='course'` + create the `Course`. Products with no matching published legacy
 * course are left untouched. This script NEVER inserts a new Product — so it cannot
 * bloat the catalog with legacy courses nobody sells.
 *
 * Keying convention (matches backfill-course-legacy-id + migrate-course-sections):
 *   legacy course.course_id  ==  Product.legacyId  ==  Course.legacyCourseId
 *
 * Idempotent: updates by id, upserts Course by productId. Safe to re-run.
 *
 * Run order:  migrate-courses  ->  migrate-course-sections  ->  migrate-course-lessons
 * (backfill:course-legacy-id becomes a no-op — legacyCourseId is set here directly.)
 */

const BATCH = Number(process.env.MIGRATE_BATCH ?? 1000);

const prisma = new PrismaClient({ log: ['warn', 'error'] });

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  // eslint-disable-next-line no-console
  console.log(`[${ts}] [migrate-courses] ${msg}`);
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
}

/** Load every existing Product that carries a legacyId -> Map<legacyId, productId>. */
async function loadExistingProductLegacyIds(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  let cursor = 0;
  while (true) {
    const rows = await prisma.product.findMany({
      where: { legacyId: { not: null, gt: cursor } },
      select: { id: true, legacyId: true },
      orderBy: { legacyId: 'asc' },
      take: 20000,
    });
    if (rows.length === 0) break;
    for (const r of rows) {
      if (r.legacyId !== null) map.set(r.legacyId, r.id);
    }
    cursor = rows[rows.length - 1].legacyId as number;
  }
  return map;
}

/** Fetch published legacy course rows for a chunk of course_ids. */
async function fetchLegacyCourses(
  legacy: Connection,
  ids: number[],
): Promise<LegacyCourseRow[]> {
  if (ids.length === 0) return [];
  const [rows] = await legacy.query<LegacyCourseRow[]>(
    `SELECT course_id, code, slug, title, description, price, tags, selling_point
       FROM course
      WHERE course_status = 'PUBLISH'
        AND status = 1
        AND course_id IN (?)`,
    [ids],
  );
  return rows;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) log('DRY RUN — no writes to Postgres');

  const productByLegacyId = await loadExistingProductLegacyIds();
  log(`existing products with legacyId: ${productByLegacyId.size}`);
  if (productByLegacyId.size === 0) {
    log('no products to enrich — nothing to do. abort.');
    await prisma.$disconnect();
    return;
  }

  const legacy = await connectLegacyDb({ dateStrings: false });
  log('connected to legacy mariadb');

  let matched = 0;
  let updated = 0;
  let courses = 0;
  let noLegacyCourse = 0;
  let sampled = 0;

  try {
    const allIds = [...productByLegacyId.keys()];
    // Track which product legacyIds had a matching published legacy course.
    const seen = new Set<number>();

    for (let i = 0; i < allIds.length; i += BATCH) {
      const chunk = allIds.slice(i, i + BATCH);
      const rows = await fetchLegacyCourses(legacy, chunk);

      for (const r of rows) {
        const courseId = Number(r.course_id);
        const productId = productByLegacyId.get(courseId);
        if (!productId) continue; // defensive — chunk was built from the map
        seen.add(courseId);
        matched++;

        const title = nonEmpty(r.title);
        const sellingPoints = parseSellingPoints(r.selling_point);
        const price = Math.round(Number(r.price ?? 0)) || 0;

        if (dryRun) {
          if (sampled < 3) {
            sampled++;
            log(
              `sample legacyId=${courseId} product=${productId} -> type=course, ` +
                `title=${title?.slice(0, 40)}, price=${price}, sp=${JSON.stringify(sellingPoints)}`,
            );
          }
          continue;
        }

        // Update the EXISTING product in place (never insert). Only overwrite the
        // course-derived fields; leave id/createdAt/etc untouched.
        await prisma.product.update({
          where: { id: productId },
          data: {
            type: 'course',
            code: nonEmpty(r.code),
            slug: nonEmpty(r.slug),
            ...(title ? { title } : {}),
            description: nonEmpty(r.description),
            price,
            sellingPoints,
            tags: nonEmpty(r.tags),
          },
        });
        updated++;

        // Link a Course row 1:1 (upsert by productId @unique).
        await prisma.course.upsert({
          where: { productId },
          create: { productId, legacyCourseId: courseId },
          update: { legacyCourseId: courseId },
        });
        courses++;
      }

      log(`chunk ${i / BATCH + 1}: matched=${matched} updated=${updated} courses=${courses}`);
    }

    noLegacyCourse = productByLegacyId.size - seen.size;
  } finally {
    await legacy.end();
    await prisma.$disconnect();
  }

  log(
    `DONE${dryRun ? ' (dry-run, no writes)' : ''} ` +
      `productsWithLegacyId=${productByLegacyId.size} matchedPublishedCourse=${matched} ` +
      `productsUpdated=${updated} coursesLinked=${courses} noMatchingLegacyCourse=${noLegacyCourse}`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
