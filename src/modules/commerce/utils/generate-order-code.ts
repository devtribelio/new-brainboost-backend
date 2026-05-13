import { prisma } from '@/config/prisma';
import { ORDER_CODE_PREFIX } from '../constants';

/**
 * Generate human-readable order code: `BB-YYYYMMDD-####`.
 * Sequence is per-day, derived by counting today's transactions + 1.
 * Race-safe enough for MVP — `code` column has unique constraint so duplicates fail loudly.
 */
export async function generateOrderCode(now: Date = new Date()): Promise<string> {
  const yyyymmdd = formatYyyymmdd(now);
  const start = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  const count = await prisma.commerceTransaction.count({
    where: { createdAt: { gte: start, lt: end } },
  });
  const seq = String(count + 1).padStart(4, '0');
  return `${ORDER_CODE_PREFIX}-${yyyymmdd}-${seq}`;
}

function formatYyyymmdd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
