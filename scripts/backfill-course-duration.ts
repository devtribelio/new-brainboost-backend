/* eslint-disable no-console */
/**
 * Compute & persist `courses.duration_min` from its lessons.
 *
 *   course.durationMin (minutes) = round( Σ lesson.duration[seconds] / 60 )
 *
 * Lesson durations are stored in SECONDS (legacy `course_lesson.duration`);
 * the course-level aggregate is reported in MINUTES. Idempotent — safe to
 * re-run after any lesson (re-)migration.
 *
 *   pnpm tsx scripts/backfill-course-duration.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: ['error'] });

async function main() {
  const courses = await prisma.course.findMany({
    select: {
      id: true,
      durationMin: true,
      sections: { select: { lessons: { select: { duration: true } } } },
    },
  });

  let changed = 0;
  for (const c of courses) {
    const totalSeconds = c.sections.reduce(
      (secAcc, s) => secAcc + s.lessons.reduce((lAcc, l) => lAcc + (l.duration ?? 0), 0),
      0,
    );
    const minutes = Math.round(totalSeconds / 60);
    if (minutes !== c.durationMin) {
      await prisma.course.update({ where: { id: c.id }, data: { durationMin: minutes } });
      changed += 1;
    }
  }

  console.log(`[backfill-course-duration] ${courses.length} courses scanned, ${changed} updated.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
