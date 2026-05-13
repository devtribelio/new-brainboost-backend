import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function log(msg: string) {
  // eslint-disable-next-line no-console
  console.log(`[backfill-course-legacy-id] ${msg}`);
}

async function main() {
  const rows = await prisma.product.findMany({
    where: { type: 'course', legacyId: { not: null }, course: { isNot: null } },
    select: {
      legacyId: true,
      course: { select: { id: true, legacyCourseId: true } },
    },
  });

  let updated = 0;
  let alreadySet = 0;
  let skippedDup = 0;

  for (const r of rows) {
    if (!r.course || r.legacyId === null) continue;
    if (r.course.legacyCourseId !== null) {
      alreadySet++;
      continue;
    }
    try {
      await prisma.course.update({
        where: { id: r.course.id },
        data: { legacyCourseId: r.legacyId },
      });
      updated++;
    } catch {
      skippedDup++;
    }
  }

  log(`DONE updated=${updated} alreadySet=${alreadySet} skippedDup=${skippedDup}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
