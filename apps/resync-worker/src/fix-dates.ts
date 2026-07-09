/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * One-off (idempotent) correction of `created_at` (+ enrollment `date_start`) for rows
 * synced BEFORE the mysql2 `timezone: '+07:00'` fix — those landed +7h off (WIB read as
 * UTC). This re-reads the legacy source date (with the now tz-correct connection) and
 * overwrites the new-DB value by key.
 *
 *   pnpm resync:fix-dates
 *
 * Idempotent (re-reads the source of truth → always sets the correct value; safe to
 * re-run). Only touches columns NOT already fixed by the drain/re-run:
 *   members.created_at            ← member.date_register
 *   course_enrollment.created_at  ← course_enrollment.created
 *   course_enrollment.date_start  ← course_enrollment.created (legacy date_start is null)
 *   affiliate_commissions.created_at ← affiliator_commision.created
 *   reviews.created_at            ← product_review.created (mapped by product+member)
 *   post_likes.created_at         ← like.created (mapped by post+member; createMany
 *   comment_likes.created_at      ← like.created  skipDuplicates never re-touches them)
 *
 * Bulk `UPDATE ... FROM (VALUES …)` in chunks. legacy_id / uuids / timestamps are the only
 * interpolated values (ints, uuids, fixed-format literals) — no injection surface.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { connectLegacyDb } from './legacy-db';
import { toDate } from './util';

const prisma = new PrismaClient({ log: ['warn', 'error'] });
const CHUNK = 5000;

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [resync:fix-dates] ${msg}`);
}
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
/** UTC Date → unambiguous Postgres `timestamp` literal (drops tz, keeps UTC wall-clock). */
function tsLiteral(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

interface LegacyIdTable {
  pg: string;
  pgCols: string[];
  legacyTable: string;
  pk: string;
  srcCol: string;
}

const TABLES: LegacyIdTable[] = [
  { pg: 'members', pgCols: ['created_at'], legacyTable: 'member', pk: 'member_id', srcCol: 'date_register' },
  { pg: 'course_enrollment', pgCols: ['created_at', 'date_start'], legacyTable: 'course_enrollment', pk: 'course_enrollment_id', srcCol: 'created' },
  { pg: 'affiliate_commissions', pgCols: ['created_at'], legacyTable: 'affiliator_commision', pk: 'affiliator_commision_id', srcCol: 'created' },
];

async function fixByLegacyId(legacy: any, cfg: LegacyIdTable): Promise<void> {
  const present: any[] = await prisma.$queryRawUnsafe(
    `SELECT legacy_id FROM "${cfg.pg}" WHERE legacy_id IS NOT NULL`,
  );
  const legacyIds = present.map((r) => Number(r.legacy_id));
  let updated = 0;
  for (const ids of chunk(legacyIds, CHUNK)) {
    if (!ids.length) continue;
    const [rows] = await legacy.query(
      `SELECT ${cfg.pk} AS id, ${cfg.srcCol} AS src FROM ${cfg.legacyTable} WHERE ${cfg.pk} IN (?)`,
      [ids],
    );
    const values: string[] = [];
    for (const r of rows as any[]) {
      const d = toDate(r.src);
      if (!d) continue;
      values.push(`(${Number(r.id)}, '${tsLiteral(d)}'::timestamp)`);
    }
    if (!values.length) continue;
    const setClause = cfg.pgCols.map((c) => `"${c}" = v.created`).join(', ');
    updated += await prisma.$executeRawUnsafe(
      `UPDATE "${cfg.pg}" t SET ${setClause}
         FROM (VALUES ${values.join(',')}) AS v(legacy_id, created)
        WHERE t.legacy_id = v.legacy_id`,
    );
  }
  log(`${cfg.pg}: created_at${cfg.pgCols.length > 1 ? '/date_start' : ''} corrected on ${updated} rows`);
}

async function fixReviews(legacy: any): Promise<void> {
  // reviews has no legacyId → map legacy product_review by (product, member)
  const productByLegacy = new Map<number, string>();
  for (const p of await prisma.product.findMany({ where: { legacyId: { not: null } }, select: { id: true, legacyId: true } })) {
    if (p.legacyId !== null) productByLegacy.set(p.legacyId, p.id);
  }
  const memberByLegacy = new Map<number, string>();
  for (const m of await prisma.member.findMany({ where: { legacyId: { not: null } }, select: { id: true, legacyId: true } })) {
    if (m.legacyId !== null) memberByLegacy.set(m.legacyId, m.id);
  }
  const redirect = new Map<number, number>();
  for (const r of await prisma.memberRedirect.findMany({ select: { loserLegacyId: true, winnerLegacyId: true } })) {
    redirect.set(r.loserLegacyId, r.winnerLegacyId);
  }
  const resolveMember = (id: number) => memberByLegacy.get(redirect.get(id) ?? id);

  const productLegacyIds = [...productByLegacy.keys()];
  if (!productLegacyIds.length) return;
  const [rows] = await legacy.query(
    `SELECT productable_id, member_id, created FROM product_review WHERE status=1 AND productable_id IN (?)`,
    [productLegacyIds],
  );
  const values: string[] = [];
  const seen = new Set<string>();
  for (const r of rows as any[]) {
    const productId = productByLegacy.get(Number(r.productable_id));
    const memberId = resolveMember(Number(r.member_id));
    const d = toDate(r.created);
    if (!productId || !memberId || !d) continue;
    const key = `${productId}|${memberId}`;
    if (seen.has(key)) continue; // one review per (product,member)
    seen.add(key);
    values.push(`('${productId}'::uuid, '${memberId}'::uuid, '${tsLiteral(d)}'::timestamp)`);
  }
  let updated = 0;
  for (const v of chunk(values, CHUNK)) {
    if (!v.length) continue;
    updated += await prisma.$executeRawUnsafe(
      `UPDATE "reviews" t SET "created_at" = x.created
         FROM (VALUES ${v.join(',')}) AS x(product_id, member_id, created)
        WHERE t.product_id = x.product_id AND t.member_id = x.member_id`,
    );
  }
  log(`reviews: created_at corrected on ${updated} rows`);
}

async function fixLikes(legacy: any): Promise<void> {
  // likes have no legacyId and createMany(skipDuplicates) never re-touches an existing row
  // → map the legacy `like` row by (post|comment, member) composite instead.
  const memberByLegacy = new Map<number, string>();
  for (const m of await prisma.member.findMany({ where: { legacyId: { not: null } }, select: { id: true, legacyId: true } })) {
    if (m.legacyId !== null) memberByLegacy.set(m.legacyId, m.id);
  }
  const redirect = new Map<number, number>();
  for (const r of await prisma.memberRedirect.findMany({ select: { loserLegacyId: true, winnerLegacyId: true } })) {
    redirect.set(r.loserLegacyId, r.winnerLegacyId);
  }
  const resolveMember = (id: number) => memberByLegacy.get(redirect.get(id) ?? id);

  const targets: Array<{
    pg: string;
    fk: string;
    idMap: Map<number, string>;
    where: string;
    legacyCol: string;
  }> = [];
  const postMap = new Map<number, string>();
  for (const p of await prisma.post.findMany({ where: { legacyId: { not: null } }, select: { id: true, legacyId: true } })) {
    postMap.set(p.legacyId as number, p.id);
  }
  targets.push({ pg: 'post_likes', fk: 'post_id', idMap: postMap, where: '(comment_id IS NULL OR comment_id=0) AND post_id IN (?)', legacyCol: 'post_id' });
  const commentMap = new Map<number, string>();
  for (const c of await prisma.comment.findMany({ where: { legacyId: { not: null } }, select: { id: true, legacyId: true } })) {
    commentMap.set(c.legacyId as number, c.id);
  }
  targets.push({ pg: 'comment_likes', fk: 'comment_id', idMap: commentMap, where: 'comment_id<>0 AND comment_id IN (?)', legacyCol: 'comment_id' });

  for (const t of targets) {
    let updated = 0;
    for (const ids of chunk([...t.idMap.keys()], CHUNK)) {
      if (!ids.length) continue;
      const [rows] = await legacy.query(
        `SELECT ${t.legacyCol} AS target_id, member_id, created FROM \`like\`
          WHERE status=1 AND member_id IS NOT NULL AND ${t.where}`,
        [ids],
      );
      const values: string[] = [];
      const seen = new Set<string>();
      for (const r of rows as any[]) {
        const targetId = t.idMap.get(Number(r.target_id));
        const memberId = resolveMember(Number(r.member_id));
        const d = toDate(r.created);
        if (!targetId || !memberId || !d) continue;
        const key = `${targetId}|${memberId}`;
        if (seen.has(key)) continue; // composite unique on the new side
        seen.add(key);
        values.push(`('${targetId}'::uuid, '${memberId}'::uuid, '${tsLiteral(d)}'::timestamp)`);
      }
      for (const v of chunk(values, CHUNK)) {
        if (!v.length) continue;
        updated += await prisma.$executeRawUnsafe(
          `UPDATE "${t.pg}" t SET "created_at" = x.created
             FROM (VALUES ${v.join(',')}) AS x(target_id, member_id, created)
            WHERE t."${t.fk}" = x.target_id AND t.member_id = x.member_id`,
        );
      }
    }
    log(`${t.pg}: created_at corrected on ${updated} rows`);
  }
}

async function main() {
  const started = Date.now();
  const legacy = await connectLegacyDb({ dateStrings: false }); // tz +07:00 baked in
  log('correcting created_at from legacy (tz-fixed connection)…');
  try {
    for (const cfg of TABLES) await fixByLegacyId(legacy, cfg);
    await fixReviews(legacy);
    await fixLikes(legacy);
    log(`DONE in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } finally {
    await legacy.end();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[resync:fix-dates] fatal', err);
  process.exit(1);
});
