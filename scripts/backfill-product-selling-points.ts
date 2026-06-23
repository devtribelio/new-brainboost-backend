import 'dotenv/config';
import type { RowDataPacket } from 'mysql2/promise';
import { PrismaClient, Prisma } from '@prisma/client';
import { connectLegacyDb } from './legacy-db';

const prisma = new PrismaClient();

function log(msg: string) {
  // eslint-disable-next-line no-console
  console.log(`[backfill-selling-points] ${msg}`);
}

interface LegacyRow extends RowDataPacket {
  course_id: number;
  selling_point: string | null;
}

async function main() {
  const products = await prisma.product.findMany({
    where: {
      type: 'course',
      legacyId: { not: null },
      sellingPoints: { equals: Prisma.AnyNull },
    },
    select: { id: true, legacyId: true },
  });
  log(`local course-products w/ null sellingPoints: ${products.length}`);

  if (products.length === 0) {
    log('nothing to backfill');
    await prisma.$disconnect();
    return;
  }

  const legacyIds = products
    .map((p) => p.legacyId)
    .filter((x): x is number => x !== null);

  const legacy = await connectLegacyDb({ dateStrings: false });

  const [rows] = await legacy.query<LegacyRow[]>(
    'SELECT course_id, selling_point FROM course WHERE course_id IN (?) AND selling_point IS NOT NULL AND selling_point != ""',
    [legacyIds],
  );
  await legacy.end();

  const sourceMap = new Map<number, string>();
  for (const r of rows) sourceMap.set(Number(r.course_id), r.selling_point ?? '');

  let updated = 0;
  let skippedNoSource = 0;
  let skippedBadJson = 0;

  for (const p of products) {
    if (p.legacyId === null) continue;
    const raw = sourceMap.get(p.legacyId);
    if (!raw) {
      skippedNoSource++;
      continue;
    }
    let parsed: Prisma.InputJsonValue;
    try {
      parsed = JSON.parse(raw) as Prisma.InputJsonValue;
    } catch {
      skippedBadJson++;
      continue;
    }
    await prisma.product.update({
      where: { id: p.id },
      data: { sellingPoints: parsed },
    });
    updated++;
  }

  log(
    `DONE updated=${updated} skippedNoSource=${skippedNoSource} skippedBadJson=${skippedBadJson}`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
