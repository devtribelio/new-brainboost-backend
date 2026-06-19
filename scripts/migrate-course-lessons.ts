import 'dotenv/config';
import type { RowDataPacket } from 'mysql2/promise';
import { PrismaClient, Prisma } from '@prisma/client';
import { connectLegacyDb } from './legacy-db';

const BATCH = Number(process.env.MIGRATE_BATCH ?? 1000);

const prisma = new PrismaClient();

function log(msg: string) {
  // eslint-disable-next-line no-console
  console.log(`[migrate-course-lessons] ${msg}`);
}

interface LegacyLessonRow extends RowDataPacket {
  course_lesson_id: number;
  course_section_id: number | null;
  code: string | null;
  title: string | null;
  description: string | null;
  lesson_status: string | null;
  duration: number | null;
  is_preview: number | null;
  order_column: number | null;
  slides_data: string | null;
  created: Date | null;
}

function parseSlides(raw: string | null): Prisma.InputJsonValue | null {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as Prisma.InputJsonValue;
  } catch {
    return raw;
  }
}

async function main() {
  const sections = await prisma.courseSection.findMany({
    select: { id: true, legacySectionId: true },
  });
  const sectionMap = new Map<number, string>();
  for (const s of sections) sectionMap.set(s.legacySectionId, s.id);

  const courses = await prisma.course.findMany({
    where: { legacyCourseId: { not: null } },
    select: { legacyCourseId: true },
  });
  const legacyCourseIds = courses
    .map((c) => c.legacyCourseId)
    .filter((x): x is number => x !== null);

  log(
    `local sections: ${sectionMap.size}, scoped legacy courses: ${legacyCourseIds.length}`,
  );

  if (sectionMap.size === 0) {
    log('no sections — run pnpm migrate:course-sections first. abort.');
    await prisma.$disconnect();
    return;
  }
  if (legacyCourseIds.length === 0) {
    log('no courses w/ legacyCourseId — abort.');
    await prisma.$disconnect();
    return;
  }

  const legacy = await connectLegacyDb({ dateStrings: false });

  let cursor = 0;
  let inserted = 0;
  let skippedNoSection = 0;
  let skippedDup = 0;
  let codeCollisions = 0;
  const seenCodes = new Set<string>();

  while (true) {
    const [rows] = await legacy.query<LegacyLessonRow[]>(
      `SELECT course_lesson_id, course_section_id, code, title, description,
              lesson_status, duration, is_preview, order_column, slides_data, created
         FROM course_lesson
        WHERE status = 1
          AND course_section_id IS NOT NULL
          AND course_lesson_id > ?
          AND course_id IN (?)
        ORDER BY course_lesson_id ASC
        LIMIT ?`,
      [cursor, legacyCourseIds, BATCH],
    );
    if (rows.length === 0) break;
    cursor = Number(rows[rows.length - 1].course_lesson_id);

    const data: {
      legacyLessonId: number;
      sectionId: string;
      name: string;
      description: string | null;
      slidesData: Prisma.InputJsonValue | null;
      code: string | null;
      lessonStatus: string;
      isPreview: boolean;
      duration: number;
      order: number;
      createdAt: Date;
    }[] = [];

    for (const r of rows) {
      if (r.course_section_id === null) continue;
      const sectionId = sectionMap.get(Number(r.course_section_id));
      if (!sectionId) {
        skippedNoSection++;
        continue;
      }
      const name = (r.title ?? '').trim() || '(untitled)';
      let code: string | null = (r.code ?? '').trim() || null;
      if (code && seenCodes.has(code)) {
        code = null;
        codeCollisions++;
      } else if (code) {
        seenCodes.add(code);
      }
      data.push({
        legacyLessonId: Number(r.course_lesson_id),
        sectionId,
        name,
        description: r.description ?? null,
        slidesData: parseSlides(r.slides_data),
        code,
        lessonStatus: (r.lesson_status ?? 'INACTIVE').trim() || 'INACTIVE',
        isPreview: Number(r.is_preview ?? 0) > 0,
        duration: Number(r.duration ?? 0),
        order: Number(r.order_column ?? 0),
        createdAt: r.created ?? new Date(),
      });
    }

    if (data.length) {
      try {
        const res = await prisma.lesson.createMany({
          data: data.map((d) => ({
            ...d,
            slidesData: d.slidesData ?? Prisma.JsonNull,
          })),
          skipDuplicates: true,
        });
        inserted += res.count;
        skippedDup += data.length - res.count;
      } catch {
        for (const row of data) {
          const payload = {
            ...row,
            slidesData: row.slidesData ?? Prisma.JsonNull,
          };
          try {
            await prisma.lesson.create({ data: payload });
            inserted++;
          } catch {
            try {
              await prisma.lesson.create({
                data: { ...payload, code: null },
              });
              inserted++;
              if (row.code) codeCollisions++;
            } catch {
              skippedDup++;
            }
          }
        }
      }
    }

    log(
      `page done cursor=${cursor} inserted=${inserted} skippedNoSection=${skippedNoSection} skippedDup=${skippedDup} codeCollisions=${codeCollisions}`,
    );
  }

  await legacy.end();
  await prisma.$disconnect();
  log(
    `DONE inserted=${inserted} skippedNoSection=${skippedNoSection} skippedDup=${skippedDup} codeCollisions=${codeCollisions}`,
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
