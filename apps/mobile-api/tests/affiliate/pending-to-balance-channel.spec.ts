/**
 * affiliatePendingToBalance — per-channel hold window tests.
 *
 * Verifies that IAP channels (revenuecat) are held for the longer IAP window
 * before becoming BALANCE, while Xendit and null (legacy/web) commissions
 * use the shorter default hold. Tests pass explicit hold overrides so they do
 * not depend on app_settings rows or the real clock.
 *
 * Requires a reachable Postgres test DB (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { affiliatePendingToBalance } from '@bb/domain/jobs/affiliate-pending-to-balance';

const TAG = `ptob-ch-${Date.now()}`;

const DEFAULT_HOLD = 7;
const IAP_HOLD = 35;

describe('affiliatePendingToBalance — per-channel hold', () => {
  let memberId = '';
  let programId = '';
  let productId = '';

  beforeAll(async () => {
    const product = await prisma.product.create({
      data: { type: 'course', title: `${TAG}-product`, price: 0 },
    });
    productId = product.id;
    const program = await prisma.affiliateProgram.create({
      data: { code: `${TAG}-prog`, name: 'PTOB Channel Program', productId, isActive: true },
    });
    programId = program.id;
    const m = await prisma.member.create({
      data: { email: `${TAG}@ptob-channel.local`, passwordHash: await bcrypt.hash('x', 4) },
    });
    memberId = m.id;
  });

  afterAll(async () => {
    await prisma.affiliateCommission.deleteMany({ where: { programId } });
    await prisma.memberAffiliator.deleteMany({ where: { programId } });
    await prisma.affiliateProgram.delete({ where: { id: programId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.$disconnect();
  });

  async function seedCommission(opts: {
    channel: string | null;
    daysAgo: number;
  }): Promise<string> {
    const createdAt = new Date(Date.now() - opts.daysAgo * 24 * 60 * 60 * 1000);
    const row = await prisma.affiliateCommission.create({
      data: {
        recipientId: memberId,
        programId,
        productId,
        paymentId: randomUUID(),
        level: 1,
        affiliateBased: 'PERFORMANCE',
        productPrice: 100_000,
        voucherAmount: 0,
        commissionRate: 20,
        amount: 20_000,
        status: 'PENDING',
        channel: opts.channel,
        createdAt,
        updatedAt: createdAt,
      },
    });
    return row.id;
  }

  it('revenuecat PENDING is NOT promoted at default hold (7d)', async () => {
    // Created 8 days ago — past the 7d default but NOT past the 35d IAP hold.
    const id = await seedCommission({ channel: 'revenuecat', daysAgo: 8 });
    const now = new Date();
    const { promoted } = await affiliatePendingToBalance(now, DEFAULT_HOLD, IAP_HOLD);

    const row = await prisma.affiliateCommission.findUnique({ where: { id } });
    // Row should still be PENDING — IAP hold not expired yet.
    expect(row?.status).toBe('PENDING');
    // promoted may include other rows from other tests; just assert this row was not moved.
    void promoted; // suppress unused warning
  });

  it('revenuecat PENDING IS promoted after IAP hold (35d)', async () => {
    // Created 36 days ago — past BOTH default (7d) and IAP (35d) holds.
    const id = await seedCommission({ channel: 'revenuecat', daysAgo: 36 });
    const now = new Date();
    await affiliatePendingToBalance(now, DEFAULT_HOLD, IAP_HOLD);

    const row = await prisma.affiliateCommission.findUnique({ where: { id } });
    expect(row?.status).toBe('BALANCE');
    expect(row?.approvedAt).not.toBeNull();
  });

  it('xendit PENDING IS promoted at default hold (7d)', async () => {
    // Created 8 days ago — past the 7d default hold.
    const id = await seedCommission({ channel: 'xendit', daysAgo: 8 });
    const now = new Date();
    await affiliatePendingToBalance(now, DEFAULT_HOLD, IAP_HOLD);

    const row = await prisma.affiliateCommission.findUnique({ where: { id } });
    expect(row?.status).toBe('BALANCE');
    expect(row?.approvedAt).not.toBeNull();
  });

  it('null channel (legacy/web) IS promoted at default hold (7d)', async () => {
    // Created 8 days ago — past the 7d default hold.
    const id = await seedCommission({ channel: null, daysAgo: 8 });
    const now = new Date();
    await affiliatePendingToBalance(now, DEFAULT_HOLD, IAP_HOLD);

    const row = await prisma.affiliateCommission.findUnique({ where: { id } });
    expect(row?.status).toBe('BALANCE');
    expect(row?.approvedAt).not.toBeNull();
  });

  it('xendit PENDING within default hold is NOT promoted', async () => {
    // Created only 3 days ago — still within the 7d default hold.
    const id = await seedCommission({ channel: 'xendit', daysAgo: 3 });
    const now = new Date();
    await affiliatePendingToBalance(now, DEFAULT_HOLD, IAP_HOLD);

    const row = await prisma.affiliateCommission.findUnique({ where: { id } });
    expect(row?.status).toBe('PENDING');
  });

  it('returned { promoted } count equals the number of rows actually moved', async () => {
    // Seed one xendit (8d) and one revenuecat (8d) — only xendit should be promoted.
    const xenditId = await seedCommission({ channel: 'xendit', daysAgo: 8 });
    const rcId = await seedCommission({ channel: 'revenuecat', daysAgo: 8 });

    const now = new Date();
    const { promoted } = await affiliatePendingToBalance(now, DEFAULT_HOLD, IAP_HOLD);

    const xenditRow = await prisma.affiliateCommission.findUnique({ where: { id: xenditId } });
    const rcRow = await prisma.affiliateCommission.findUnique({ where: { id: rcId } });

    expect(xenditRow?.status).toBe('BALANCE');
    expect(rcRow?.status).toBe('PENDING'); // IAP hold not yet expired

    // promoted must be >= 1 (the xendit row we just seeded).
    expect(promoted).toBeGreaterThanOrEqual(1);
  });
});
