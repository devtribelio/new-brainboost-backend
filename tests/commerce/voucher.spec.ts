import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { VoucherService } from '@/modules/commerce/voucher.service';
import { prisma } from '@/config/prisma';

describe('VoucherService', () => {
  const service = new VoucherService();
  let productAId: string;
  let productBId: string;
  const ts = Date.now();
  const codes = {
    valid: `T-VOUCH-VALID-${ts}`,
    inactive: `T-VOUCH-INACTIVE-${ts}`,
    wrongProduct: `T-VOUCH-WRONG-${ts}`,
    expired: `T-VOUCH-EXPIRED-${ts}`,
    notYet: `T-VOUCH-FUTURE-${ts}`,
    exhausted: `T-VOUCH-EXHAUSTED-${ts}`,
    quotaOne: `T-VOUCH-RACE-${ts}`,
  };

  beforeAll(async () => {
    const productA = await prisma.product.create({
      data: { type: 'course', title: 'Voucher Test Product A', price: 500_000 },
    });
    productAId = productA.id;
    const productB = await prisma.product.create({
      data: { type: 'course', title: 'Voucher Test Product B', price: 100_000 },
    });
    productBId = productB.id;

    await prisma.voucher.createMany({
      data: [
        { code: codes.valid, type: 'AMOUNT', value: 50_000, isActive: true },
        { code: codes.inactive, type: 'AMOUNT', value: 50_000, isActive: false },
        {
          code: codes.wrongProduct,
          type: 'AMOUNT',
          value: 50_000,
          isActive: true,
          productId: productBId,
        },
        {
          code: codes.expired,
          type: 'AMOUNT',
          value: 50_000,
          isActive: true,
          endsAt: new Date(Date.now() - 24 * 3600 * 1000),
        },
        {
          code: codes.notYet,
          type: 'AMOUNT',
          value: 50_000,
          isActive: true,
          startsAt: new Date(Date.now() + 24 * 3600 * 1000),
        },
        {
          code: codes.exhausted,
          type: 'AMOUNT',
          value: 50_000,
          isActive: true,
          quota: 1,
          used: 1,
        },
        {
          code: codes.quotaOne,
          type: 'PERCENT',
          value: 10,
          isActive: true,
          quota: 1,
          used: 0,
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.voucher.deleteMany({ where: { code: { in: Object.values(codes) } } });
    await prisma.product.deleteMany({ where: { id: { in: [productAId, productBId] } } });
    await prisma.$disconnect();
  });

  it('returns invalid for unknown code', async () => {
    const r = await service.validate('DOES-NOT-EXIST', productAId);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/not found/i);
  });

  it('returns invalid for inactive voucher', async () => {
    const r = await service.validate(codes.inactive, productAId);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/inactive/i);
  });

  it('returns invalid when voucher scoped to different product', async () => {
    const r = await service.validate(codes.wrongProduct, productAId);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/applicable/i);
  });

  it('returns invalid for expired voucher', async () => {
    const r = await service.validate(codes.expired, productAId);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/expired/i);
  });

  it('returns invalid for not-yet-active voucher', async () => {
    const r = await service.validate(codes.notYet, productAId);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/yet active/i);
  });

  it('returns invalid when quota exhausted', async () => {
    const r = await service.validate(codes.exhausted, productAId);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/exhaust/i);
  });

  it('returns valid for valid voucher', async () => {
    const r = await service.validate(codes.valid, productAId);
    expect(r.valid).toBe(true);
    expect(r.type).toBe('AMOUNT');
    expect(r.voucherAmount).toBe(50_000);
    expect(r.voucherId).toBeDefined();
  });

  it('atomic redeem: only one of two parallel redeems succeeds when quota=1', async () => {
    const v = await prisma.voucher.findUnique({ where: { code: codes.quotaOne } });
    expect(v).toBeTruthy();
    const [r1, r2] = await Promise.allSettled([service.redeem(v!.id), service.redeem(v!.id)]);
    const ok = [r1, r2].filter((r) => r.status === 'fulfilled').length;
    const fail = [r1, r2].filter((r) => r.status === 'rejected').length;
    expect(ok).toBe(1);
    expect(fail).toBe(1);

    const after = await prisma.voucher.findUnique({ where: { id: v!.id } });
    expect(after?.used).toBe(1);
  });
});
