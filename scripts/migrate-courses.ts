import 'dotenv/config';
import type { RowDataPacket } from 'mysql2/promise';
import { PrismaClient, Prisma } from '@prisma/client';
import { connectLegacyDb } from './legacy-db';

/**
 * One-shot: legacy MariaDB `course` table -> new Postgres `Product(type='course')` + `Course`.
 *
 *   pnpm tsx scripts/migrate-courses.ts
 *
 * WHY THIS EXISTS
 * ---------------
 * `migrate-from-legacy.ts::migrateProducts` reads the legacy `product` table and
 * writes Products with `type='legacy'` and NO linked `Course` row. Courses are a
 * SEPARATE legacy entity (`course` table). Without this script there are zero
 * `Product(type='course')` + `Course` rows, so `grantCourseEnrollment` short-circuits
 * (`product.type !== 'course' || !product.course`) and course_enrollment is never
 * written on a successful payment.
 *
 * Keying convention (matches backfill-course-legacy-id + migrate-course-sections):
 *   legacy course.course_id  ==  Product.legacyId  ==  Course.legacyCourseId
 *
 * Idempotent: upserts on legacyId / productId. Safe to re-run.
 *
 * Run order:  migrate-courses  ->  migrate-course-sections  ->  migrate-course-lessons
 * (backfill:course-legacy-id becomes a no-op — legacyCourseId is set here directly.)
 *
 * CAVEAT: Product.legacyId is globally unique. If the legacy `product` and `course`
 * tables share overlapping integer ids AND both are migrated, the two will collide on
 * legacyId. In practice course sales map to the `course` table, so prefer this script
 * for course products and skip the `products` phase of migrate-from-legacy for them.
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

function date(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** legacy `selling_point` is a JSON string[] (legacy stores it serialized). */
function parseSellingPoints(raw: unknown): Prisma.InputJsonValue | undefined {
  const v = nonEmpty(raw);
  if (v === null) return undefined;
  try {
    const parsed = JSON.parse(v);
    return parsed as Prisma.InputJsonValue;
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
  description_html: string | null;
  price: number | string | null;
  tags: string | null;
  selling_point: string | null;
  marketing_link: string | null;
  course_status: string | null;
  created: Date | null;
}

async function main() {
  const legacy = await connectLegacyDb({ dateStrings: false });
  log('connected to legacy mariadb');

  let cursor = 0;
  let products = 0;
  let courses = 0;
  let skippedNoTitle = 0;

  try {
    while (true) {
      const [rows] = await legacy.query<LegacyCourseRow[]>(
        `SELECT course_id, code, slug, title, description, description_html,
                price, tags, selling_point, marketing_link, course_status, created
           FROM course
          WHERE course_status = 'PUBLISH'
            AND course_id > ?
          ORDER BY course_id ASC
          LIMIT ?`,
        [cursor, BATCH],
      );
      if (rows.length === 0) break;
      cursor = Number(rows[rows.length - 1].course_id);

      for (const r of rows) {
        const courseId = Number(r.course_id);
        const title = nonEmpty(r.title);
        if (!title) {
          skippedNoTitle++;
          continue;
        }

        const sellingPoints = parseSellingPoints(r.selling_point);
        const price = Math.round(Number(r.price ?? 0)) || 0;
        const createdAt = date(r.created) ?? new Date();

        // 1. Product (type='course'). Upsert by legacyId == legacy course_id.
        const product = await prisma.product.upsert({
          where: { legacyId: courseId },
          create: {
            legacyId: courseId,
            type: 'course',
            code: nonEmpty(r.code),
            slug: nonEmpty(r.slug),
            title,
            description: nonEmpty(r.description),
            descriptionHtml: nonEmpty(r.description_html),
            price,
            marketingLink: nonEmpty(r.marketing_link),
            sellingPoints,
            tags: nonEmpty(r.tags),
            status: 'active',
            isActive: true,
            createdAt,
          },
          update: {
            // Force type so any row previously imported as 'legacy' is corrected.
            type: 'course',
            code: nonEmpty(r.code),
            slug: nonEmpty(r.slug),
            title,
            description: nonEmpty(r.description),
            descriptionHtml: nonEmpty(r.description_html),
            price,
            marketingLink: nonEmpty(r.marketing_link),
            sellingPoints,
            tags: nonEmpty(r.tags),
            status: 'active',
            isActive: true,
          },
          select: { id: true },
        });
        products++;

        // 2. Course row linked 1:1 to the Product. Upsert by productId (@unique).
        await prisma.course.upsert({
          where: { productId: product.id },
          create: {
            productId: product.id,
            legacyCourseId: courseId,
          },
          update: {
            legacyCourseId: courseId,
          },
        });
        courses++;
      }

      log(`page done cursor=${cursor} products=${products} courses=${courses}`);
    }
  } finally {
    await legacy.end();
    await prisma.$disconnect();
  }

  log(`DONE products=${products} courses=${courses} skippedNoTitle=${skippedNoTitle}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
