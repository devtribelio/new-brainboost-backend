import 'dotenv/config';
import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import { PrismaClient } from '@prisma/client';

const LEGACY_HOST =
  process.env.LEGACY_DB_HOST ??
  'tribelio-db-rds1-mariadb.cly0dad2a29h.ap-southeast-1.rds.amazonaws.com';
const LEGACY_USER = process.env.LEGACY_DB_USER ?? 'tribelio_readonly';
const LEGACY_PASS = process.env.LEGACY_DB_PASS ?? '3373kfh6g0ZG0tgCU5J0';
const LEGACY_DB = process.env.LEGACY_DB_NAME ?? 'tribelio_db';
const BATCH = Number(process.env.MIGRATE_BATCH ?? 1000);

const prisma = new PrismaClient();

function log(msg: string) {
  // eslint-disable-next-line no-console
  console.log(`[migrate-reviews] ${msg}`);
}

interface LegacyReviewRow extends RowDataPacket {
  product_review_id: number;
  productable_id: number;
  member_id: number;
  rating: number;
  note: string | null;
  created: Date | null;
  updated: Date | null;
}

async function main() {
  const products = await prisma.product.findMany({
    where: { legacyId: { not: null } },
    select: { id: true, legacyId: true },
  });
  const productMap = new Map<number, string>();
  for (const p of products) {
    if (p.legacyId !== null) productMap.set(p.legacyId, p.id);
  }

  const members = await prisma.member.findMany({
    where: { legacyId: { not: null } },
    select: { id: true, legacyId: true },
  });
  const memberMap = new Map<number, string>();
  for (const m of members) {
    if (m.legacyId !== null) memberMap.set(m.legacyId, m.id);
  }

  log(
    `local products w/ legacyId: ${productMap.size}, members w/ legacyId: ${memberMap.size}`,
  );

  if (productMap.size === 0) {
    log('no local products mapped — abort');
    await prisma.$disconnect();
    return;
  }

  const legacy = await mysql.createConnection({
    host: LEGACY_HOST,
    user: LEGACY_USER,
    password: LEGACY_PASS,
    database: LEGACY_DB,
    dateStrings: false,
  });

  const productLegacyIds = [...productMap.keys()];
  let cursor = 0;
  let inserted = 0;
  let skippedNoMember = 0;
  let skippedDup = 0;
  let clampedZero = 0;
  let skippedBadRating = 0;

  while (true) {
    const [rows] = await legacy.query<LegacyReviewRow[]>(
      `SELECT product_review_id, productable_id, member_id, rating, note, created, updated
         FROM product_review
        WHERE status = 1
          AND product_review_id > ?
          AND productable_id IN (?)
        ORDER BY product_review_id ASC
        LIMIT ?`,
      [cursor, productLegacyIds, BATCH],
    );
    if (rows.length === 0) break;
    cursor = Number(rows[rows.length - 1].product_review_id);

    const data: {
      productId: string;
      memberId: string;
      stars: number;
      comment: string | null;
      createdAt: Date;
      updatedAt: Date;
    }[] = [];

    for (const r of rows) {
      const productId = productMap.get(Number(r.productable_id));
      const memberId = memberMap.get(Number(r.member_id));
      if (!productId) continue;
      if (!memberId) {
        skippedNoMember++;
        continue;
      }
      let stars = Number(r.rating);
      if (stars === 0) {
        stars = 1;
        clampedZero++;
      }
      if (stars < 1 || stars > 5) {
        skippedBadRating++;
        continue;
      }
      data.push({
        productId,
        memberId,
        stars,
        comment: r.note ?? null,
        createdAt: r.created ?? new Date(),
        updatedAt: r.updated ?? r.created ?? new Date(),
      });
    }

    if (data.length) {
      try {
        const res = await prisma.review.createMany({
          data,
          skipDuplicates: true,
        });
        inserted += res.count;
        skippedDup += data.length - res.count;
      } catch {
        for (const row of data) {
          try {
            await prisma.review.create({ data: row });
            inserted++;
          } catch {
            skippedDup++;
          }
        }
      }
    }

    log(
      `page done cursor=${cursor} inserted=${inserted} skippedNoMember=${skippedNoMember} skippedDup=${skippedDup} clampedZero=${clampedZero} skippedBadRating=${skippedBadRating}`,
    );
  }

  await legacy.end();
  await prisma.$disconnect();
  log(
    `DONE inserted=${inserted} skippedNoMember=${skippedNoMember} skippedDup=${skippedDup} clampedZero=${clampedZero} skippedBadRating=${skippedBadRating}`,
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
