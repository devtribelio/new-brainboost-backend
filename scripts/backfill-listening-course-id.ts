import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { isUuid } from '../packages/common/src/utils/uuid.util';

/**
 * Rewrite `listening_session.course_id` from `products.id` to `courses.id`.
 *
 *   pnpm backfill:listening-course-id                          # DRY RUN, whole table
 *   pnpm backfill:listening-course-id --member=<uuid|email>    # DRY RUN, one member
 *   pnpm backfill:listening-course-id --member=<…> --apply     # write, one member
 *   pnpm backfill:listening-course-id --apply                  # write, WHOLE TABLE
 *
 * Dry run is the DEFAULT here, unlike the other `backfill:*` scripts. Those repair a
 * column nothing else writes; this one rewrites ~171k rows of an ingest log on a live
 * table, so the write is opt-in and `--member` gives you a canary first.
 *
 * ## Why this exists
 *
 * The app sends a `products.id` in a field named `courseId` (docs/tracker-streak.md
 * §8b). Two fixes already landed and this is NOT one of them:
 *
 *  - reads accept both id spaces, so every surface is already correct;
 *  - `TrackingService` normalises at write, so new rows are already correct.
 *
 * This is cleanup: it converges the stored data on one id space so the column stops
 * lying and the tolerant read can eventually be dropped. Nothing breaks if it never
 * runs, which is why it is safe to defer until someone can watch it.
 *
 * ## Run it AFTER the write-path fix is deployed
 *
 * Otherwise the client keeps appending wrong rows behind the update as it walks.
 * Harmless (re-runnable), but you will not reach zero.
 *
 * ## Reversal is not clean — read before applying
 *
 * Rows converted here become indistinguishable from rows that were always correct
 * (the Firebase `tracker:backfill` has written a real `courses.id` all along). A
 * blanket reverse would therefore also break those. If you need a rollback path, take
 * a table snapshot first; this script deliberately does not write a 171k-id undo file.
 *
 * Idempotent: a second run finds nothing to do. Orphans — ids matching neither table —
 * are reported and left ALONE, the same rule the write path follows: this is an ingest
 * log, and the raw value is the only evidence of what the client sent.
 */

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const memberArg = args.find((a) => a.startsWith('--member='))?.slice('--member='.length);

const unknown = args.filter((a) => a !== '--apply' && !a.startsWith('--member='));
if (unknown.length > 0) {
  console.error(`Unknown argument(s): ${unknown.join(', ')}`);
  console.error('Usage: pnpm backfill:listening-course-id [--member=<uuid|email>] [--apply]');
  process.exit(1);
}

const prisma = new PrismaClient();

async function resolveMemberId(input: string): Promise<string> {
  // Shape-check first: `members.id` is `@db.Uuid`, so querying it with an email makes
  // Postgres reject the cast and surfaces a Prisma internal error instead of falling
  // through to the email lookup.
  if (isUuid(input)) {
    const byId = await prisma.member.findUnique({ where: { id: input }, select: { id: true } });
    if (byId) return byId.id;
    throw new Error(`No member with id ${input}`);
  }
  const byEmail = await prisma.member.findFirst({ where: { email: input }, select: { id: true } });
  if (byEmail) return byEmail.id;
  throw new Error(`No member with email ${input}`);
}

async function main(): Promise<void> {
  const memberId = memberArg ? await resolveMemberId(memberArg) : undefined;
  const scope = memberId ? { memberId } : {};

  console.log(`\n${apply ? '⚠️  APPLY' : 'DRY RUN'}  scope=${memberId ?? 'ALL MEMBERS'}\n`);

  // Distinct ids only — bounded by the number of courses (tens), not by row count.
  const groups = await prisma.listeningSession.groupBy({
    by: ['courseId'],
    where: { ...scope, courseId: { not: null } },
    _count: { _all: true },
  });
  const ids = groups.map((g) => g.courseId!).filter(Boolean);
  const rowsOf = new Map(groups.map((g) => [g.courseId!, g._count._all]));

  if (ids.length === 0) {
    console.log('No session carries a courseId. Nothing to do.\n');
    return;
  }

  const [asCourse, asProduct] = await Promise.all([
    prisma.course.findMany({ where: { id: { in: ids } }, select: { id: true } }),
    prisma.course.findMany({
      where: { productId: { in: ids } },
      select: { id: true, productId: true, product: { select: { title: true } } },
    }),
  ]);
  const alreadyCourse = new Set(asCourse.map((c) => c.id));
  // An id that is a valid `courses.id` is left alone even if it also happens to be
  // some other course's `product_id` — same precedence the write-path resolver uses,
  // and the only reading under which this stays idempotent.
  const toConvert = asProduct.filter((c) => !alreadyCourse.has(c.productId));
  const convertible = new Set(toConvert.map((c) => c.productId));
  const orphans = ids.filter((id) => !alreadyCourse.has(id) && !convertible.has(id));

  const sum = (list: string[]) => list.reduce((n, id) => n + (rowsOf.get(id) ?? 0), 0);
  console.log(`distinct ids            ${ids.length}`);
  console.log(`  already courses.id    ${alreadyCourse.size} ids / ${sum([...alreadyCourse])} rows  (left alone)`);
  console.log(`  products.id → convert ${convertible.size} ids / ${sum([...convertible])} rows`);
  console.log(`  orphan (neither)      ${orphans.length} ids / ${sum(orphans)} rows  (left alone)\n`);

  if (orphans.length > 0) {
    console.log('ORPHANS — match neither table, deliberately untouched:');
    for (const id of orphans) console.log(`  ${id}  rows=${rowsOf.get(id)}`);
    console.log('');
  }

  if (toConvert.length === 0) {
    console.log('Nothing to convert.\n');
    return;
  }

  console.log(`${apply ? 'CONVERTING' : 'WOULD CONVERT'}:`);
  let touched = 0;
  for (const c of toConvert) {
    const rows = rowsOf.get(c.productId) ?? 0;
    const label = `  ${c.productId} → ${c.id}  rows=${String(rows).padStart(6)}  ${c.product.title}`;
    if (!apply) {
      console.log(label);
      touched += rows;
      continue;
    }
    // One UPDATE per distinct id — tens of statements, not 171k.
    const res = await prisma.listeningSession.updateMany({
      where: { ...scope, courseId: c.productId },
      data: { courseId: c.id },
    });
    touched += res.count;
    console.log(`${label}  → updated ${res.count}`);
  }

  console.log(`\n${apply ? 'Updated' : 'Would update'} ${touched} row(s).`);
  if (!apply) console.log('Re-run with --apply to write. Consider --member=<…> as a canary first.');
  console.log('');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
