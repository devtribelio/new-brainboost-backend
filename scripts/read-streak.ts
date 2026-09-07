import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { isUuid } from '../packages/common/src/utils/uuid.util';
import { StatsService } from '../apps/mobile-api/src/modules/tracker/stats.service';

/**
 * Read one member's streak exactly as the API reports it — QA / support tool.
 *
 *   pnpm streak:read --member=<uuid|email>
 *   pnpm streak:read --member=<…> --json     # machine-readable, for piping
 *
 * Read-only: no writes, no pushes, no stamps. Safe on production.
 *
 * It calls the real `StatsService`, not a reimplementation of the streak rules —
 * a script with its own copy of the walk would agree with the member's screen
 * only until one of the two drifted, which is precisely when you would be
 * reaching for this.
 *
 * The last section is the reason this exists in the shape it does. Per-program
 * challenges read 0 for everyone until 2026-09-04 because
 * `listening_session.course_id` holds a `products.id` while the enrollment holds
 * a `courses.id` (docs/tracker-streak.md §8b). The ID SHAPE block reports, per
 * distinct id this member actually has on their rows, which table it resolves
 * against — so "the challenge card says 0" can be answered from data instead of
 * from a guess about which client build wrote the row.
 */

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const memberArg = args.find((a) => a.startsWith('--member='))?.slice('--member='.length);

const unknown = args.filter((a) => a !== '--json' && !a.startsWith('--member='));
if (unknown.length > 0 || !memberArg) {
  console.error(unknown.length > 0 ? `Unknown argument(s): ${unknown.join(', ')}` : '--member is required');
  console.error('Usage: pnpm streak:read --member=<uuid|email> [--json]');
  process.exit(1);
}

const prisma = new PrismaClient();

async function resolveMember(input: string) {
  // Shape-check first: `members.id` is `@db.Uuid`, so querying it with an email
  // makes Postgres reject the cast and surfaces a Prisma internal error instead
  // of falling through to the email lookup.
  const select = { id: true, email: true, fullName: true, createdAt: true } as const;
  if (isUuid(input)) {
    const byId = await prisma.member.findUnique({ where: { id: input }, select });
    if (byId) return byId;
    throw new Error(`No member with id ${input}`);
  }
  const byEmail = await prisma.member.findFirst({ where: { email: input }, select });
  if (byEmail) return byEmail;
  throw new Error(`No member with email ${input}`);
}

function hhmm(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

/**
 * Which table each `course_id` on this member's rows actually resolves against.
 * `courses.product_id` is unique, so a product id maps back to exactly one course.
 */
async function idShape(memberId: string) {
  const groups = await prisma.listeningSession.groupBy({
    by: ['courseId'],
    where: { memberId, courseId: { not: null } },
    _count: { _all: true },
  });
  const ids = groups.map((g) => g.courseId!).filter(Boolean);
  if (ids.length === 0) return [];

  const [courses, products] = await Promise.all([
    prisma.course.findMany({ where: { id: { in: ids } }, select: { id: true } }),
    prisma.course.findMany({
      where: { productId: { in: ids } },
      select: { id: true, productId: true, product: { select: { title: true } } },
    }),
  ]);
  const courseIds = new Set(courses.map((c) => c.id));
  const byProduct = new Map(products.map((c) => [c.productId, c]));

  return groups.map((g) => {
    const id = g.courseId!;
    const viaProduct = byProduct.get(id);
    return {
      id,
      rows: g._count._all,
      resolvesAs: courseIds.has(id) ? 'courses.id' : viaProduct ? 'products.id' : 'ORPHAN',
      course: viaProduct ? viaProduct.id : courseIds.has(id) ? id : null,
      title: viaProduct?.product.title ?? null,
    };
  });
}

async function main(): Promise<void> {
  const member = await resolveMember(memberArg!);
  const stats = new StatsService();

  const home = await stats.home(member.id);
  const perCourse = await Promise.all(
    home.challenges.map(async (c) => ({
      ...c,
      detail: await stats.courseStats(member.id, c.courseId),
    })),
  );
  const shape = await idShape(member.id);

  if (asJson) {
    console.log(JSON.stringify({ member, home, perCourse, idShape: shape }, null, 2));
    return;
  }

  console.log(`\nMEMBER   ${member.fullName ?? '(no name)'}  <${member.email ?? 'no email'}>`);
  console.log(`         ${member.id}   joined ${member.createdAt.toISOString().slice(0, 10)}`);

  console.log(`\nGLOBAL STREAK`);
  console.log(`  today (listening day)  ${home.today}   rollover ${home.streak.dayBoundaryHour}:00 WIB`);
  console.log(`  streakDays             ${home.streakDays}   state=${home.streak.state}`);
  if (home.streak.restoreDeadline) console.log(`  restoreDeadline        ${home.streak.restoreDeadline}`);
  console.log(`  sessionsPlayed         ${home.sessionsPlayed}`);
  console.log(`  totalListenSec         ${home.totalListenSec} (${hhmm(home.totalListenSec)})`);
  console.log(`  qualifyThresholdSec    ${home.qualifyThresholdSec}`);

  console.log(`\nWEEKLY STRIP (Mon→Sun, WIB)`);
  console.log(`  ${home.weeklyStreak.map((e) => e.date.slice(5)).join('  ')}`);
  console.log(`  ${home.weeklyStreak.map((e) => e.state.padEnd(7).slice(0, 7)).join(' ')}`);
  console.log(`  weeklyRecap  week ${home.weeklyRecap.weekNumber}` +
    `  daysActive ${home.weeklyRecap.daysActive}/${home.weeklyRecap.daysTarget}` +
    `  listened ${hhmm(home.weeklyRecap.listenSec)}`);

  console.log(`\nPER-PROGRAM CHALLENGES  (${perCourse.length})`);
  if (perCourse.length === 0) console.log('  (no active enrollment)');
  for (const c of perCourse) {
    console.log(`  ${c.title}  [${c.code ?? '-'}]`);
    console.log(`    courseId        ${c.courseId}`);
    console.log(`    challenge day   ${c.day} / ${c.target}`);
    console.log(`    courseStats     days=${c.detail.daysListened}  total=${hhmm(c.detail.totalListenSec)}` +
      `  last=${c.detail.lastListenedAt ?? 'never'}`);
  }

  console.log(`\nID SHAPE of this member's listening_session.course_id  (${shape.length} distinct)`);
  if (shape.length === 0) console.log('  (no session carries a courseId)');
  for (const s of shape) {
    const note = s.resolvesAs === 'ORPHAN' ? '  ← matches NEITHER table' : '';
    console.log(`  ${s.id}  rows=${String(s.rows).padStart(5)}  ${s.resolvesAs}${note}`);
    if (s.title) console.log(`    └─ ${s.title}  → courses.id ${s.course}`);
  }
  const orphans = shape.filter((s) => s.resolvesAs === 'ORPHAN').length;
  if (orphans > 0) console.log(`\n  ⚠️  ${orphans} id(s) resolve against neither table — those rows can never be bucketed.`);
  console.log('');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
