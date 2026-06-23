/**
 * Regenerate tests/affiliate/fixtures/legacy-commission-parity.json from the legacy
 * production MariaDB (read-only). These are GOLDEN fixtures for the affiliate parity test.
 *
 *   pnpm tsx scripts/extract-affiliate-parity-fixtures.ts
 *
 * Connection comes from LEGACY_DB_* in .env (see scripts/legacy-db.ts).
 *
 * Curated, verified clean payouts (no duplicate-level rows from the legacy double-commit bug).
 * Add new payment ids here to widen coverage. GROWTH chain nodes are emitted as affiliateBased
 * "GROWTH" (legacy pre-snapshot rows store NULL but are multitier-by-level). PERFORMANCE tiers
 * carry a synthetic seedLifetime so the new engine derives the same rate the legacy pbs_aff_* gave.
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RowDataPacket } from 'mysql2';
import { connectLegacyDb } from './legacy-db';

const GROWTH_PAYMENTS = [655, 6505];
const PERFORMANCE_PAYMENTS: Array<{ paymentId: number; seedLifetime: number }> = [
  { paymentId: 266570, seedLifetime: 0 }, // tier 1 (20%)
  { paymentId: 266479, seedLifetime: 6_000_000 }, // tier 2 (30%)
  { paymentId: 266565, seedLifetime: 16_000_000 }, // tier 3 (40%)
];
const INACTIVE_PAYMENTS = [220787];

interface LegacyRow extends RowDataPacket {
  level: number;
  rate: number;
  amount: number;
  affiliate_based: string | null;
  pay_amount: number;
  pay_voucher: number;
}

async function fetchPayout(
  conn: Awaited<ReturnType<typeof connectLegacyDb>>,
  paymentId: number,
): Promise<LegacyRow[]> {
  const [rows] = await conn.query<LegacyRow[]>(
    `SELECT ac.level,
            ac.commision_amount AS rate,
            ac.price_recipient  AS amount,
            ac.affiliate_based,
            cp.amount         AS pay_amount,
            cp.amount_voucher AS pay_voucher
       FROM affiliator_commision ac
       JOIN course_payment cp ON cp.course_payment_id = ac.payment_id
      WHERE ac.payment_model = 'TBModel_CoursePayment' AND ac.payment_id = ?
      ORDER BY ac.level ASC`,
    [paymentId],
  );
  if (rows.length === 0) throw new Error(`No commission rows for course_payment#${paymentId}`);
  return rows;
}

function expectedFrom(rows: LegacyRow[]) {
  return rows.map((r) => ({ level: Number(r.level), rate: Number(r.rate), amount: Math.round(Number(r.amount)) }));
}

async function main() {
  const conn = await connectLegacyDb();
  const scenarios: unknown[] = [];

  try {
    for (const paymentId of GROWTH_PAYMENTS) {
      const rows = await fetchPayout(conn, paymentId);
      scenarios.push({
        name: `GROWTH ${rows.length}-level multitier — legacy course_payment ${paymentId}`,
        legacyRef: `TBModel_CoursePayment#${paymentId}`,
        productPrice: Number(rows[0].pay_amount),
        voucherAmount: Number(rows[0].pay_voucher),
        chain: rows.map((r) => ({ level: Number(r.level), affiliateBased: 'GROWTH' })),
        expected: expectedFrom(rows),
      });
    }

    for (const { paymentId, seedLifetime } of PERFORMANCE_PAYMENTS) {
      const rows = await fetchPayout(conn, paymentId);
      const r = rows[0];
      scenarios.push({
        name: `PERFORMANCE (${r.rate}%) single recipient — legacy course_payment ${paymentId}`,
        legacyRef: `TBModel_CoursePayment#${paymentId}`,
        productPrice: Number(r.pay_amount),
        voucherAmount: Number(r.pay_voucher),
        chain: [{ level: 1, affiliateBased: 'PERFORMANCE', seedLifetime }],
        expected: expectedFrom([r]),
      });
    }

    for (const paymentId of INACTIVE_PAYMENTS) {
      const rows = await fetchPayout(conn, paymentId);
      const r = rows[0];
      scenarios.push({
        name: `INACTIVE flat ${r.rate}% single recipient — legacy course_payment ${paymentId}`,
        legacyRef: `TBModel_CoursePayment#${paymentId}`,
        productPrice: Number(r.pay_amount),
        voucherAmount: Number(r.pay_voucher),
        chain: [{ level: 1, affiliateBased: 'INACTIVE' }],
        expected: expectedFrom([r]),
      });
    }
  } finally {
    await conn.end();
  }

  const out = {
    _comment:
      'Golden parity fixtures extracted from legacy production MariaDB via scripts/extract-affiliate-parity-fixtures.ts. Do not hand-edit amounts — regenerate.',
    scenarios,
  };
  const dir = join(__dirname, '..', 'tests', 'affiliate', 'fixtures');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'legacy-commission-parity.json');
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote ${scenarios.length} scenarios -> ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
