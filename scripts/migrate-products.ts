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
 * BRIDGE = `code`, create-if-missing
 * -----------------------------------
 * If a Product already exists in the new DB carrying the legacy `course.code` (an
 * app-created product), match `Product.code == course.code` and ENRICH it in place —
 * this never duplicates the app's catalog. If NO product matches (e.g. a fresh DB),
 * CREATE the product (keyed by `legacyId = course_id`). Either way set type='course',
 * legacyId, the course fields, then upsert Course(productId, legacyCourseId = course_id).
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

// Legacy course cover lives in the polymorphic `resource` table (Spatie media,
// collection `courseImage`, disk s3-resource), NOT on the course/product table.
// Public URL: {base}/resources/{YYYYMMDD}/{model_type}/{resource_id}/{file_name}
// where YYYYMMDD is the first 8 chars of file_name. Verified 200 on production bucket.
const RESOURCE_BASE =
  process.env.LEGACY_RESOURCE_BASE ??
  'https://tribelio-s3-production.s3.ap-southeast-1.amazonaws.com';

function buildResourceUrl(resourceId: number, fileName: string): string {
  const day = fileName.slice(0, 8); // YYYYMMDD prefix of the hashed file name
  return `${RESOURCE_BASE}/resources/${day}/TBModel_Course/${resourceId}/${fileName}`;
}

/** courseId -> latest active courseImage URL. */
async function loadCourseThumbnails(
  legacy: Connection,
  courseIds: number[],
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (courseIds.length === 0) return map;
  // Highest resource_id = most recent upload; status=1 = current.
  const [rows] = await legacy.query<RowDataPacket[]>(
    `SELECT model_id, resource_id, file_name FROM resource
      WHERE model_type = 'TBModel_Course' AND collection_name = 'courseImage'
        AND status = 1 AND file_name <> '' AND model_id IN (?)
      ORDER BY resource_id DESC`,
    [courseIds],
  );
  for (const r of rows as any[]) {
    const cid = Number(r.model_id);
    if (!map.has(cid)) map.set(cid, buildResourceUrl(Number(r.resource_id), String(r.file_name)));
  }
  return map;
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

  let updated = 0; // existing product enriched (bridged by code)
  let created = 0; // new product inserted (fresh DB / no code match)
  let courses = 0;

  try {
    const rows = await fetchBrainboostCourses(legacy);
    log(`brainboost published courses: ${rows.length}`);

    const thumbByCourse = await loadCourseThumbnails(
      legacy,
      rows.map((r) => Number(r.course_id)),
    );
    log(`courses with a thumbnail: ${thumbByCourse.size}`);

    for (const r of rows) {
      const courseId = Number(r.course_id);
      const code = nonEmpty(r.code);
      if (!code) continue;

      const title = nonEmpty(r.title) ?? `Course ${courseId}`;
      const sellingPoints = parseSellingPoints(r.selling_point);
      const price = Math.round(Number(r.price ?? 0)) || 0;
      const existingId = productByCode.get(code); // bridge by code

      if (dryRun) {
        if (updated + created < 3) {
          log(
            `sample code=${code} course_id=${courseId} -> ${existingId ? 'ENRICH ' + existingId : 'CREATE'} ` +
              `type=course title=${title.slice(0, 40)} price=${price}`,
          );
        }
        existingId ? updated++ : created++;
        continue;
      }

      // Shared course-derived fields.
      const fields = {
        type: 'course' as const,
        code,
        slug: nonEmpty(r.slug),
        title,
        description: nonEmpty(r.description),
        thumbnail: thumbByCourse.get(courseId) ?? null,
        price,
        marketingLink: nonEmpty(r.marketing_link),
        sellingPoints,
        tags: nonEmpty(r.tags),
      };

      let productId: string;
      if (existingId) {
        // Enrich the existing app-created product in place (bridge by code).
        await prisma.product.update({
          where: { id: existingId },
          data: { ...fields, legacyId: courseId },
        });
        productId = existingId;
        updated++;
      } else {
        // Fresh DB / no code match → create the product (keyed by legacyId = course_id).
        const p = await prisma.product.upsert({
          where: { legacyId: courseId },
          create: { ...fields, legacyId: courseId, status: 'active', isActive: true },
          update: { ...fields },
          select: { id: true },
        });
        productId = p.id;
        created++;
      }

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

  log(
    `DONE${dryRun ? ' (dry-run, no writes)' : ''} ` +
      `enriched=${updated} created=${created} coursesLinked=${courses}`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
