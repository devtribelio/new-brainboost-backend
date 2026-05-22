/**
 * Disbursement service integration test. Member-scoped only (safe on shared/staging DB):
 * it never runs the global PENDING->BALANCE job, it seeds BALANCE commissions directly.
 * Requires a reachable Postgres test DB (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@/config/prisma';
import { DisbursementService } from '@/modules/affiliate/disbursement.service';

const TAG = `disb-${Date.now()}`;
const svc = new DisbursementService();

describe('DisbursementService', () => {
  let memberId = '';
  let programId = '';
  let productId = '';

  beforeAll(async () => {
    const product = await prisma.product.create({ data: { type: 'course', title: `${TAG}-p`, price: 0 } });
    productId = product.id;
    const program = await prisma.affiliateProgram.create({
      data: { code: `${TAG}-prog`, name: 'Disb Program', productId, isActive: true },
    });
    programId = program.id;
    const m = await prisma.member.create({
      data: { email: `${TAG}@disb.local`, passwordHash: await bcrypt.hash('x', 4) },
    });
    memberId = m.id;

    // Two cleared (BALANCE) commissions totalling 100,000.
    for (const amount of [60_000, 40_000]) {
      await prisma.affiliateCommission.create({
        data: {
          recipientId: memberId,
          programId,
          productId,
          paymentId: randomUUID(),
          level: 1,
          affiliateBased: 'PERFORMANCE',
          productPrice: amount,
          voucherAmount: 0,
          commissionRate: 20,
          amount,
          status: 'BALANCE',
        },
      });
    }
    // One still-pending commission must NOT count toward withdrawable balance.
    await prisma.affiliateCommission.create({
      data: {
        recipientId: memberId,
        programId,
        productId,
        paymentId: randomUUID(),
        level: 1,
        affiliateBased: 'PERFORMANCE',
        productPrice: 30_000,
        voucherAmount: 0,
        commissionRate: 20,
        amount: 30_000,
        status: 'PENDING',
      },
    });
  });

  afterAll(async () => {
    await prisma.affiliateDisbursement.deleteMany({ where: { memberId } });
    await prisma.affiliateCommission.deleteMany({ where: { recipientId: memberId } });
    await prisma.affiliateProgram.delete({ where: { id: programId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.$disconnect();
  });

  it('withdrawable balance = sum(BALANCE), excludes PENDING', async () => {
    expect(await svc.getWithdrawableBalance(memberId)).toBe(100_000);
  });

  it('requestDisbursement consumes the balance and blocks a concurrent request', async () => {
    const d = await svc.requestDisbursement(memberId);
    expect(d.grossAmount).toBe(100_000);
    expect(d.fee).toBe(5_000);
    expect(d.netAmount).toBe(95_000);
    expect(d.status).toBe('PENDING');

    // Balance is now consumed by the in-flight payout.
    expect(await svc.getWithdrawableBalance(memberId)).toBe(0);

    // A second request must be blocked while one is PENDING.
    await expect(svc.requestDisbursement(memberId)).rejects.toThrow(/pending withdrawal/i);
  });

  it('markFailed releases the held balance back to withdrawable', async () => {
    const pending = await prisma.affiliateDisbursement.findFirst({
      where: { memberId, status: 'PENDING' },
    });
    expect(pending).not.toBeNull();
    await svc.markFailed(pending!.id, 'provider rejected (test)');
    expect(await svc.getWithdrawableBalance(memberId)).toBe(100_000);
  });
});
