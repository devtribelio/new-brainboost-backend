import 'dotenv/config';
import type { RowDataPacket } from 'mysql2/promise';
import { PrismaClient } from '@prisma/client';
import { connectLegacyDb } from './legacy-db';

const BATCH = Number(process.env.MIGRATE_BATCH ?? 1000);

const prisma = new PrismaClient();

function log(msg: string) {
  // eslint-disable-next-line no-console
  console.log(`[migrate-course-sections] ${msg}`);
}

interface LegacySectionRow extends RowDataPacket {
  course_section_id: number;
  course_id: number;
  name: string | null;
  description: string | null;
  order_column: number | null;
  created: Date | null;
}

async function main() {
  const courses = await prisma.course.findMany({
    where: { legacyCourseId: { not: null } },
    select: { id: true, legacyCourseId: true },
  });
  const courseMap = new Map<number, string>();
  for (const c of courses) {
    if (c.legacyCourseId !== null) courseMap.set(c.legacyCourseId, c.id);
  }

  log(`local courses w/ legacyCourseId: ${courseMap.size}`);
  if (courseMap.size === 0) {
    log('no mapped courses — run pnpm backfill:course-legacy-id first. abort.');
    await prisma.$disconnect();
    return;
  }

  const legacy = await connectLegacyDb({ dateStrings: false });

  const legacyCourseIds = [...courseMap.keys()];
  let cursor = 0;
  let inserted = 0;
  let skippedNoCourse = 0;
  let skippedDup = 0;

  while (true) {
    const [rows] = await legacy.query<LegacySectionRow[]>(
      `SELECT course_section_id, course_id, name, description, order_column, created
         FROM course_section
        WHERE status = 1
          AND course_section_id > ?
          AND course_id IN (?)
        ORDER BY course_section_id ASC
        LIMIT ?`,
      [cursor, legacyCourseIds, BATCH],
    );
    if (rows.length === 0) break;
    cursor = Number(rows[rows.length - 1].course_section_id);

    const data: {
      legacySectionId: number;
      courseId: string;
      name: string;
      order: number;
      createdAt: Date;
    }[] = [];

    for (const r of rows) {
      const courseId = courseMap.get(Number(r.course_id));
      if (!courseId) {
        skippedNoCourse++;
        continue;
      }
      const name = (r.name ?? '').trim() || '(untitled)';
      data.push({
        legacySectionId: Number(r.course_section_id),
        courseId,
        name,
        order: Number(r.order_column ?? 0),
        createdAt: r.created ?? new Date(),
      });
    }

    if (data.length) {
      try {
        const res = await prisma.courseSection.createMany({
          data,
          skipDuplicates: true,
        });
        inserted += res.count;
        skippedDup += data.length - res.count;
      } catch {
        for (const row of data) {
          try {
            await prisma.courseSection.create({ data: row });
            inserted++;
          } catch {
            skippedDup++;
          }
        }
      }
    }

    log(
      `page done cursor=${cursor} inserted=${inserted} skippedNoCourse=${skippedNoCourse} skippedDup=${skippedDup}`,
    );
  }

  await legacy.end();
  await prisma.$disconnect();
  log(
    `DONE inserted=${inserted} skippedNoCourse=${skippedNoCourse} skippedDup=${skippedDup}`,
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
