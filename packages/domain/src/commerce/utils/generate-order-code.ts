import crypto from 'node:crypto';
import { prisma } from '@bb/db';
import { ORDER_CODE_PREFIX } from '../constants';

/**
 * Generate human-readable order code: `BB-YYYYMMDD-####`.
 * Sequence is per-day, derived by counting today's transactions + 1.
 *
 * The count-based sequence is NOT collision-proof under concurrency: two
 * inserts racing in the same instant read the same count and derive the same
 * code (the `code` unique constraint then rejects one). Callers under burst
 * load (e.g. the RevenueCat webhook handling an IAP-restore flood) must retry
 * on a `code` P2002 with `jitter: true`, which appends a random suffix so the
 * retry can't collide again. The default (no jitter) keeps the clean
 * `BB-YYYYMMDD-####` format for the normal interactive path.
 */
export async function generateOrderCode(
  now: Date = new Date(),
  opts: { jitter?: boolean } = {},
): Promise<string> {
  const yyyymmdd = formatYyyymmdd(now);
  const start = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  const count = await prisma.commerceTransaction.count({
    where: { createdAt: { gte: start, lt: end } },
  });
  const seq = String(count + 1).padStart(4, '0');
  const suffix = opts.jitter ? `-${crypto.randomBytes(2).toString('hex').toUpperCase()}` : '';
  return `${ORDER_CODE_PREFIX}-${yyyymmdd}-${seq}${suffix}`;
}

function formatYyyymmdd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
