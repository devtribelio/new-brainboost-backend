import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

/**
 * Backfill missing course enrollments for already-PAID purchases of course-backed
 * products (course + mini_course).
 *
 * Why: `grantCourseEnrollment` used to gate on `product.type === 'course'`, so
 * mini_course purchases committed a commission but never created the enrollment
 * (xendit + revenuecat alike — both converge on commerce.payment.success).
 * The code fix keys on the linked `course` row instead; this script repairs the
 * rows that were already missed.
 *
 * Source of truth = PAID CommerceTransaction (covers web/Xendit + ingested
 * RevenueCat/Scalev/Lynk.id purchases). For each, if no (memberId, courseId)
 * enrollment exists, create one with dateStart = paidAt ?? createdAt.
 *
 * SAFE BY DEFAULT: dry-run unless `--apply` is passed. Idempotent (skipDuplicates
 * + pre-check), so re-running never double-enrolls.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-mini-course-enrollment.ts            # dry-run
 *   pnpm tsx scripts/backfill-mini-course-enrollment.ts --apply    # write
 */
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

function log(msg: string) {
  // eslint-disable-next-line no-console
  console.log(`[backfill-mini-course-enrollment] ${msg}`);
}

async function main() {
  log(APPLY ? 'MODE=APPLY (will write)' : 'MODE=DRY-RUN (no writes; pass --apply to write)');

  // PAID purchases of products that have a linked course row.
  const txs = await prisma.commerceTransaction.findMany({
    where: { status: 'PAID', product: { course: { isNot: null } } },
    select: {
      id: true,
      memberId: true,
      productId: true,
      paidAt: true,
      createdAt: true,
      product: { select: { type: true, title: true, course: { select: { id: true } } } },
    },
  });
  log(`found ${txs.length} PAID transactions on course-backed products`);

  // Dedupe by (memberId, courseId) — a member may have multiple PAID tx for one product.
  const wanted = new Map<
    string,
    { memberId: string; courseId: string; dateStart: Date; type: string; title: string }
  >();
  for (const tx of txs) {
    const courseId = tx.product.course?.id;
    if (!courseId) continue;
    const key = `${tx.memberId}:${courseId}`;
    const dateStart = tx.paidAt ?? tx.createdAt;
    const existing = wanted.get(key);
    // Keep the earliest purchase date.
    if (!existing || dateStart < existing.dateStart) {
      wanted.set(key, {
        memberId: tx.memberId,
        courseId,
        dateStart,
        type: tx.product.type,
        title: tx.product.title,
      });
    }
  }

  // Which of those already have an enrollment?
  const courseIds = [...new Set([...wanted.values()].map((w) => w.courseId))];
  const existing = await prisma.courseEnrollment.findMany({
    where: { courseId: { in: courseIds } },
    select: { memberId: true, courseId: true },
  });
  const haveSet = new Set(existing.map((e) => `${e.memberId}:${e.courseId}`));

  const missing = [...wanted.entries()].filter(([key]) => !haveSet.has(key)).map(([, v]) => v);

  // Breakdown by product type (course rows should be ~0; mini_course is the bug).
  const byType: Record<string, number> = {};
  for (const m of missing) byType[m.type] = (byType[m.type] ?? 0) + 1;
  log(`missing enrollments: ${missing.length} — by type: ${JSON.stringify(byType)}`);

  // Per-product detail for visibility.
  const byTitle: Record<string, number> = {};
  for (const m of missing) byTitle[`${m.type}:${m.title}`] = (byTitle[`${m.type}:${m.title}`] ?? 0) + 1;
  for (const [title, n] of Object.entries(byTitle)) log(`  ${n}× ${title}`);

  if (!APPLY) {
    log('DRY-RUN complete — no rows written. Re-run with --apply to create the enrollments.');
    await prisma.$disconnect();
    return;
  }

  if (missing.length === 0) {
    log('nothing to backfill.');
    await prisma.$disconnect();
    return;
  }

  const created = await prisma.courseEnrollment.createMany({
    data: missing.map((m) => ({ memberId: m.memberId, courseId: m.courseId, dateStart: m.dateStart })),
    skipDuplicates: true,
  });
  log(`APPLY complete — created ${created.count} enrollment(s) (requested ${missing.length}).`);
  await prisma.$disconnect();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
