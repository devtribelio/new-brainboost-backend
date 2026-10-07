/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * Export the legacy enrollments the resync would CANCEL (audit §6 / PRD P0-3) to a CSV.
 *
 *   pnpm export:enrollment-cancels --out=/path/to/file.csv
 *
 * Read-only. For every legacy `course_enrollment` in brainboost scope with `status = 0`
 * (the only removal signal legacy has — there is no `deleted` column, `cancelation_reason`
 * is always NULL, `is_canceled` is always 0), it writes:
 *   - tanggal            : legacy `created` (WIB)
 *   - status             : legacy `status`
 *   - tanggal_dicabut    : legacy `updated` (WIB) — when the row flipped to status=0
 *   - alasan_dicabut     : the resync's cancel reason (`legacy_removed`)
 *   - legacy_updatedby   : `system` (automated/cron) or NULL — best available "who removed it"
 *   - plus the decision inputs: payment status/amount, an active sibling enrollment, the PG row
 *     and whether the cancel would be allowed (aksi / blocked_reason).
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import type { RowDataPacket } from 'mysql2/promise';
import { connectResilientLegacy } from './legacy-db';
import { resyncConfig } from './config';

const out =
  process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length) ??
  'enrollment-cancel-list.csv';
const log = (m: string) => console.log(`[export:cancel] ${m}`);

const SCOPE_SQL = `SELECT course_id FROM course WHERE client = 'brainboost'
  UNION
  SELECT course_id FROM course_payment
   WHERE client_product = 'brainboost' AND payment_status = 'SUCCESS' AND course_id IS NOT NULL`;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient({ log: ['warn', 'error'] });
  const legacy = await connectResilientLegacy({ dateStrings: true }, resyncConfig.legacyReconnectRetries, log);
  try {
    log('reading legacy course_enrollment (status=0, brainboost scope)…');
    const [rows] = await legacy.query<RowDataPacket[]>(
      `SELECT e.course_enrollment_id AS enroll_id,
              e.member_id            AS member_legacy,
              e.course_id            AS course_legacy,
              e.status               AS legacy_status,
              e.is_canceled          AS legacy_is_canceled,
              e.cancelation_reason   AS legacy_cancel_reason,
              DATE_FORMAT(e.created,      '%Y-%m-%d %H:%i:%s') AS created_wib,
              DATE_FORMAT(e.updated,      '%Y-%m-%d %H:%i:%s') AS removed_wib,
              DATE_FORMAT(e.expired_date, '%Y-%m-%d %H:%i:%s') AS expired_wib,
              e.updatedby            AS legacy_updatedby,
              m.email                AS member_email,
              m.phone                AS member_phone,
              cp.course_payment_id   AS payment_id,
              cp.payment_status      AS payment_status,
              cp.amount              AS payment_amount,
              EXISTS (SELECT 1 FROM course_enrollment s
                       WHERE s.member_id = e.member_id AND s.course_id = e.course_id
                         AND s.course_enrollment_id <> e.course_enrollment_id
                         AND s.status = 1) AS has_active_sibling
         FROM course_enrollment e
         LEFT JOIN course_payment cp ON cp.course_payment_id = e.course_payment_id
         LEFT JOIN member m ON m.member_id = e.member_id
        WHERE e.status = 0 AND e.member_id IS NOT NULL
          AND e.course_id IN (${SCOPE_SQL})
        ORDER BY e.member_id, e.course_enrollment_id`,
    );
    log(`legacy rows: ${(rows as any[]).length}`);

    const enrollIds = (rows as any[]).map((r) => Number(r.enroll_id));
    const memberIds = [...new Set((rows as any[]).map((r) => Number(r.member_legacy)))];

    log('reading Postgres mirror + catalog…');
    const pgEnroll = new Map<number, any>();
    for (let i = 0; i < enrollIds.length; i += 5000) {
      for (const e of await prisma.courseEnrollment.findMany({
        where: { legacyId: { in: enrollIds.slice(i, i + 5000) } },
        select: { id: true, legacyId: true, memberId: true, courseId: true, isCanceled: true, cancelationReason: true },
      })) {
        if (e.legacyId !== null) pgEnroll.set(e.legacyId, e);
      }
    }
    const memberByLegacy = new Map<number, string>();
    for (let i = 0; i < memberIds.length; i += 5000) {
      for (const m of await prisma.member.findMany({
        where: { legacyId: { in: memberIds.slice(i, i + 5000) } },
        select: { id: true, legacyId: true },
      })) {
        if (m.legacyId !== null) memberByLegacy.set(m.legacyId, m.id);
      }
    }
    const courseByLegacy = new Map<number, { id: string; productId: string }>();
    for (const c of await prisma.course.findMany({
      where: { legacyCourseId: { not: null } },
      select: { id: true, productId: true, legacyCourseId: true },
    })) {
      if (c.legacyCourseId !== null) courseByLegacy.set(c.legacyCourseId, { id: c.id, productId: c.productId });
    }
    const titleByProduct = new Map<string, string>();
    for (const p of await prisma.product.findMany({ select: { id: true, title: true } })) {
      titleByProduct.set(p.id, p.title);
    }
    // paid orders in the NEW system (the syncer's hasPaidOrder guard)
    const paidKeys = new Set<string>();
    for (const t of await prisma.commerceTransaction.findMany({
      where: { status: 'PAID', amount: { gt: 0 } },
      select: { memberId: true, productId: true },
      distinct: ['memberId', 'productId'],
    })) {
      paidKeys.add(`${t.memberId}|${t.productId}`);
    }

    const header = [
      'enrollment_legacy_id',
      'member_legacy_id',
      'pg_enrollment_id',
      'course_legacy_id',
      'course_title',
      'tanggal',
      'status',
      'tanggal_dicabut',
      'alasan_dicabut',
      'legacy_updatedby',
      'member_email',
      'member_phone',
      'payment_id',
      'payment_status',
      'payment_amount',
      'expired_date',
      'has_active_sibling',
      'pg_is_canceled',
      'pg_has_paid_order',
      'aksi',
      'blocked_reason',
    ];

    const summary: Record<string, number> = {};
    const lines = [header.join(',')];
    for (const r of rows as any[]) {
      const legacyId = Number(r.enroll_id);
      const course = courseByLegacy.get(Number(r.course_legacy));
      const pg = pgEnroll.get(legacyId);
      const memberPg = memberByLegacy.get(Number(r.member_legacy));
      const hasSibling = Number(r.has_active_sibling) === 1;
      const paidInPg = !!(memberPg && course && paidKeys.has(`${memberPg}|${course.productId}`));

      let aksi = 'would_cancel';
      let blocked = '';
      if (!pg) {
        aksi = 'skip';
        blocked = 'pair_not_ours_or_not_in_pg';
      } else if (hasSibling) {
        aksi = 'skip';
        blocked = 'legacy_has_other_active_enrollment';
      } else if (paidInPg) {
        aksi = 'skip';
        blocked = 'has_paid_order_in_new_system';
      }
      summary[aksi] = (summary[aksi] ?? 0) + 1;
      if (aksi === 'skip') summary[`  ${blocked}`] = (summary[`  ${blocked}`] ?? 0) + 1;

      lines.push(
        [
          legacyId,
          r.member_legacy,
          pg?.id ?? '',
          r.course_legacy,
          course ? titleByProduct.get(course.productId) ?? '' : '',
          r.created_wib ?? '',
          r.legacy_status,
          r.removed_wib ?? '',
          'legacy_removed',
          r.legacy_updatedby ?? '',
          r.member_email ?? '',
          r.member_phone ?? '',
          r.payment_id ?? '',
          r.payment_status ?? '',
          r.payment_amount ?? '',
          r.expired_wib ?? '',
          hasSibling,
          pg ? pg.isCanceled : '',
          paidInPg,
          aksi,
          blocked,
        ]
          .map(csvCell)
          .join(','),
      );
    }

    writeFileSync(out, lines.join('\n') + '\n');
    log(`wrote ${lines.length - 1} row(s) → ${out}`);
    log(`summary: ${JSON.stringify(summary, null, 0)}`);
  } finally {
    await legacy.end();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[export:cancel] fatal', err);
  process.exit(1);
});
