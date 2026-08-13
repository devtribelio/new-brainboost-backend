/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * Backfill: RevenueCat purchases from non-IDR storefronts.
 *
 *   pnpm tsx scripts/backfill-rc-currency.ts            # dry-run (default)
 *   pnpm tsx scripts/backfill-rc-currency.ts --apply    # write
 *
 * BUG      = the RC webhook treats `price_in_purchased_currency` as IDR. True for
 *            an ID storefront, wrong for every other one: an AU purchase of
 *            A$39.99 landed as `amount = 40`, and its affiliate commission as Rp5.
 *
 * FIX      = re-derive the IDR amount through RC's own USD figure:
 *              amountIdr = round(price_usd × usdIdrRate)
 *            `price` is USD in every event regardless of storefront (verified:
 *            the USD row has price == price_in_purchased_currency exactly, and
 *            the HKD row lands on the 7.75-7.85 peg).
 *
 * RATE     = derived from our OWN IDR events — each one carries both sides of the
 *            pair (`price_in_purchased_currency / price`), so the ratio IS the
 *            USD/IDR rate RevenueCat billed with that day. Nearest sample in time
 *            wins. No external FX source, no historical API needed.
 *
 * CLAMP    = a computed amount outside 0.25x-4x the catalog price is refused (row
 *            reported, not written). The live bug is 0.0001x, so this net catches
 *            it even if every other assumption breaks.
 *
 * SCOPE    = payments + their transactions + commissions that are still PENDING.
 *            A commission already moved to BALANCE is left alone and reported --
 *            reversing paid-out money is a separate decision.
 *
 * IDEMPOTENT = a stamped `log_response.backfill` marks a done row; re-runs skip it.
 *            Safe to re-run after the code fix ships to catch stragglers.
 *
 * COLUMN SYNC = the first run happened BEFORE migration 20260813120000 existed, so those
 *            rows carry their FX facts only inside `log_response.backfill`. Once the
 *            columns exist this script also copies the stamp into them. That matters
 *            beyond tidiness: `currency` has DEFAULT 'IDR', and on PG11+ that default is
 *            applied to existing rows — so an un-synced foreign payment actively CLAIMS to
 *            be rupiah, and any "list non-IDR payments" query silently misses it.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const CLAMP_LOW = 0.25;
const CLAMP_HIGH = 4;
const DEFAULT_TAKEHOME = 0.7;

type RcEvent = {
  currency?: string;
  price?: number;
  price_in_purchased_currency?: number;
  takehome_percentage?: number;
};

const idr = (n: number) => 'Rp' + n.toLocaleString('id-ID');

/**
 * The FX columns only exist from migration 20260813120000. Probed rather than assumed so
 * the script still does its main job (repairing amounts) on a database that has not been
 * migrated yet — which is exactly the order the first production run happened in.
 */
async function hasFxColumns(): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`
    SELECT count(*)::int AS n
    FROM information_schema.columns
    WHERE table_name = 'commerce_payments'
      AND column_name IN ('currency','amount_local','amount_usd','fx_rate_idr','fx_rate_source')
  `);
  return (rows[0]?.n ?? 0) === 5;
}

async function main() {
  const fxColumns = await hasFxColumns();
  if (!fxColumns) {
    console.log(
      'NOTE: FX columns absent (migration 20260813120000 not applied) — amounts will be\n' +
        '      repaired, but the snapshot columns cannot be written. Re-run after migrating.\n',
    );
  }

  const payments = await prisma.commercePayment.findMany({
    where: { paymentType: 'revenuecat' },
    select: {
      id: true,
      transactionId: true,
      amount: true,
      acceptedAmount: true,
      paidAt: true,
      createdAt: true,
      logRequest: true,
      logResponse: true,
      fxRateIdr: true,
      transaction: {
        select: {
          id: true,
          code: true,
          amount: true,
          itemTotal: true,
          product: { select: { id: true, title: true, price: true, iosPrice: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  // --- FX samples: every IDR event is a free USD/IDR observation -------------
  const samples: Array<{ t: number; rate: number }> = [];
  for (const p of payments) {
    const e = (p.logRequest ?? {}) as RcEvent;
    if (e.currency !== 'IDR') continue;
    if (!e.price || !e.price_in_purchased_currency) continue;
    samples.push({
      t: (p.paidAt ?? p.createdAt).getTime(),
      rate: e.price_in_purchased_currency / e.price,
    });
  }
  // No samples is not fatal: the column-sync pass needs no rate at all, and a database
  // with nothing to repair should report that rather than abort.
  if (samples.length === 0) {
    console.log(
      'WARNING: no IDR events to derive a USD/IDR rate from — amount repairs disabled.\n',
    );
  } else {
    console.log(
      `FX samples from IDR events: ${samples.length} ` +
        `(${Math.min(...samples.map((s) => s.rate)).toFixed(0)}-${Math.max(...samples.map((s) => s.rate)).toFixed(0)} IDR/USD)\n`,
    );
  }

  const nearest = (t: number) =>
    samples.reduce(
      (best, s) => (Math.abs(s.t - t) < Math.abs(best.t - t) ? s : best),
      samples[0]!,
    );

  // --- plan ------------------------------------------------------------------
  const planned: any[] = [];
  const syncOnly: any[] = [];
  const skipped: any[] = [];

  for (const p of payments) {
    const e = (p.logRequest ?? {}) as RcEvent;
    const cur = (e.currency ?? 'IDR').toUpperCase();
    if (cur === 'IDR') continue;

    const stamp = (p.logResponse as any)?.backfill;
    if (stamp) {
      // Amounts already fixed. Still needs its stamp copied into the columns if that ran
      // before they existed — detected by an empty fx_rate_idr rather than by run order.
      if (fxColumns && p.fxRateIdr == null && stamp.fxRateIdr != null) {
        syncOnly.push({ id: p.id, cur, stamp });
      } else {
        skipped.push({ id: p.id, cur, why: 'already backfilled' });
      }
      continue;
    }
    if (samples.length === 0) {
      skipped.push({ id: p.id, cur, why: 'no FX sample available' });
      continue;
    }
    if (!e.price || e.price <= 0) {
      skipped.push({ id: p.id, cur, why: `no usable USD price (${e.price})` });
      continue;
    }

    const catalog = p.transaction?.product?.iosPrice ?? p.transaction?.product?.price ?? 0;
    if (!catalog) {
      skipped.push({ id: p.id, cur, why: 'product has no catalog price' });
      continue;
    }

    const at = (p.paidAt ?? p.createdAt).getTime();
    const sample = nearest(at);
    const gapHours = Math.abs(sample.t - at) / 3_600_000;
    const grossIdr = Math.round(e.price * sample.rate);
    const ratio = grossIdr / catalog;

    if (ratio < CLAMP_LOW || ratio > CLAMP_HIGH) {
      skipped.push({ id: p.id, cur, why: `clamp: ${ratio.toFixed(3)}x catalog` });
      continue;
    }

    const takehome = e.takehome_percentage ?? DEFAULT_TAKEHOME;
    const acceptedIdr = Math.floor(grossIdr * takehome);

    const commissions = await prisma.affiliateCommission.findMany({
      where: { paymentId: p.id },
      select: {
        id: true,
        status: true,
        amount: true,
        productPrice: true,
        voucherAmount: true,
        commissionRate: true,
      },
    });

    planned.push({
      payment: p,
      cur,
      localPrice: e.price_in_purchased_currency,
      usd: e.price,
      rate: sample.rate,
      gapHours,
      takehome,
      grossIdr,
      acceptedIdr,
      catalog,
      commissions,
    });
  }

  // --- report ----------------------------------------------------------------
  console.log('PAYMENTS');
  console.table(
    planned.map((r) => ({
      cur: r.cur,
      local: r.localPrice,
      usd: r.usd,
      rate: +r.rate.toFixed(2),
      gap_h: +r.gapHours.toFixed(1),
      amount: `${r.payment.amount} → ${r.grossIdr}`,
      accepted: `${r.payment.acceptedAmount} → ${r.acceptedIdr}`,
      ratio: +(r.grossIdr / r.catalog).toFixed(2) + 'x',
      product: String(r.payment.transaction?.product?.title ?? '').slice(0, 28),
    })),
  );

  const commRows: any[] = [];
  for (const r of planned) {
    for (const c of r.commissions) {
      const base = r.acceptedIdr + c.voucherAmount;
      const next = Math.floor(
        Math.max(base - c.voucherAmount, 0) * (c.commissionRate / 100),
      );
      commRows.push({
        id: c.id.slice(0, 8),
        status: c.status,
        rate: c.commissionRate + '%',
        productPrice: `${c.productPrice} → ${base}`,
        amount: `${c.amount} → ${next}`,
        action: c.status === 'PENDING' ? 'update' : 'SKIP (not PENDING)',
        _apply: c.status === 'PENDING',
        _id: c.id,
        _base: base,
        _next: next,
      });
    }
  }
  console.log('\nCOMMISSIONS');
  if (commRows.length === 0) console.log('  (none linked to these payments)');
  else console.table(commRows.map(({ _apply, _id, _base, _next, ...show }) => show));

  if (syncOnly.length) {
    console.log('\nCOLUMN SYNC (amounts already correct — copying stamp into FX columns)');
    console.table(
      syncOnly.map((r) => ({
        id: r.id.slice(0, 8),
        cur: r.stamp.currency,
        amount_local: r.stamp.amountLocal,
        amount_usd: r.stamp.amountUsd,
        fx_rate_idr: r.stamp.fxRateIdr,
        fx_rate_source: r.stamp.fxRateSource,
      })),
    );
  }

  if (skipped.length) {
    console.log('\nSKIPPED');
    console.table(skipped);
  }

  const revenueDelta = planned.reduce((s, r) => s + (r.grossIdr - r.payment.amount), 0);
  const commDelta = commRows
    .filter((c) => c._apply)
    .reduce((s, c) => s + (c._next - Number(String(c.amount).split(' → ')[0])), 0);
  console.log(
    `\nSUMMARY  payments=${planned.length}  commissions=${commRows.filter((c) => c._apply).length}` +
      `  columnSync=${syncOnly.length}` +
      `  revenue Δ=${idr(revenueDelta)}  commission Δ=${idr(commDelta)}`,
  );

  if (planned.length === 0 && syncOnly.length === 0) {
    console.log('\nNothing to do.');
    return;
  }

  if (!APPLY) {
    console.log('\nDRY-RUN. Nothing written. Re-run with --apply to commit.');
    return;
  }

  // --- backup before touching anything --------------------------------------
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dump = `scripts/backfill-rc-currency.before-${stamp}.json`;
  writeFileSync(
    dump,
    JSON.stringify(
      {
        amountRepairs: planned.map((r) => ({
          paymentId: r.payment.id,
          transactionId: r.payment.transactionId,
          before: {
            paymentAmount: r.payment.amount,
            paymentAcceptedAmount: r.payment.acceptedAmount,
            transactionAmount: r.payment.transaction?.amount,
            transactionItemTotal: r.payment.transaction?.itemTotal,
            commissions: r.commissions,
          },
        })),
        // These rows only GAIN columns that are currently NULL — reverting one means
        // setting the five FX columns back to NULL. Listed so that is possible.
        columnSyncPaymentIds: syncOnly.map((r) => r.id),
      },
      null,
      2,
    ),
  );
  console.log(`\nBackup written: ${dump}`);

  // --- apply -----------------------------------------------------------------
  let payCount = 0;
  let commCount = 0;
  for (const r of planned) {
    await prisma.$transaction(async (db) => {
      await db.commercePayment.update({
        where: { id: r.payment.id },
        data: {
          amount: r.grossIdr,
          acceptedAmount: r.acceptedIdr,
          // Same five columns the live ingest path writes, so a repaired row is
          // indistinguishable from one that was never broken.
          ...(fxColumns
            ? {
                currency: r.cur,
                amountLocal: r.localPrice ?? null,
                amountUsd: r.usd,
                fxRateIdr: r.rate,
                fxRateSource: 'revenuecat_derived',
              }
            : {}),
          logResponse: {
            backfill: {
              script: 'backfill-rc-currency',
              at: new Date().toISOString(),
              reason: 'non-IDR storefront amount was stored as raw local currency',
              currency: r.cur,
              amountLocal: r.localPrice,
              amountUsd: r.usd,
              fxRateIdr: r.rate,
              fxRateSource: 'revenuecat_derived',
              before: { amount: r.payment.amount, acceptedAmount: r.payment.acceptedAmount },
            },
          },
        },
      });
      await db.commerceTransaction.update({
        where: { id: r.payment.transactionId },
        data: { amount: r.grossIdr, itemTotal: r.grossIdr },
      });
      payCount++;

      for (const c of r.commissions) {
        if (c.status !== 'PENDING') continue;
        const base = r.acceptedIdr + c.voucherAmount;
        const next = Math.floor(
          Math.max(base - c.voucherAmount, 0) * (c.commissionRate / 100),
        );
        await db.affiliateCommission.update({
          where: { id: c.id },
          data: { productPrice: base, amount: next },
        });
        commCount++;
      }
    });
  }

  // Rows repaired by an earlier run, before the columns existed: lift their stamp into
  // the columns. Amounts are already correct, so this touches nothing but the FX snapshot.
  let syncCount = 0;
  for (const r of syncOnly) {
    await prisma.commercePayment.update({
      where: { id: r.id },
      data: {
        currency: r.stamp.currency ?? null,
        amountLocal: r.stamp.amountLocal ?? null,
        amountUsd: r.stamp.amountUsd ?? null,
        fxRateIdr: r.stamp.fxRateIdr ?? null,
        fxRateSource: r.stamp.fxRateSource ?? null,
      },
    });
    syncCount++;
  }

  console.log(
    `\nAPPLIED  payments=${payCount}  commissions=${commCount}  columnSync=${syncCount}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
