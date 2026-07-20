import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { VoucherService } from '@bb/domain/commerce/voucher.service';
import { prisma } from '@bb/db';

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
    multiProduct: `T-VOUCH-MULTI-${ts}`,
    cappedPercent: `T-VOUCH-CAP-${ts}`,
    idempotent: `T-VOUCH-IDEM-${ts}`,
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
        { code: codes.wrongProduct, type: 'AMOUNT', value: 50_000, isActive: true },
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
        {
          code: codes.cappedPercent,
          type: 'PERCENT',
          value: 50,
          maxAmount: 50_000,
          isActive: true,
        },
        {
          code: codes.idempotent,
          type: 'AMOUNT',
          value: 10_000,
          isActive: true,
          used: 0,
        },
        { code: codes.multiProduct, type: 'AMOUNT', value: 50_000, isActive: true },
      ],
    });

    // Product scope now lives in the voucher_products junction (0 rows = global).
    const [wrong, multi] = await Promise.all([
      prisma.voucher.findUniqueOrThrow({ where: { code: codes.wrongProduct } }),
      prisma.voucher.findUniqueOrThrow({ where: { code: codes.multiProduct } }),
    ]);
    await prisma.voucherProduct.createMany({
      data: [
        { voucherId: wrong.id, productId: productBId },
        { voucherId: multi.id, productId: productAId },
        { voucherId: multi.id, productId: productBId },
      ],
    });
  });

  afterAll(async () => {
    const vs = await prisma.voucher.findMany({
      where: { code: { in: Object.values(codes) } },
      select: { id: true },
    });
    await prisma.voucherRedemption.deleteMany({
      where: { voucherId: { in: vs.map((v) => v.id) } },
    });
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

  it('accepts a multi-product voucher for every whitelisted product, rejects others', async () => {
    const a = await service.validate(codes.multiProduct, productAId);
    expect(a.valid).toBe(true);
    const b = await service.validate(codes.multiProduct, productBId);
    expect(b.valid).toBe(true);
    const other = await service.validate(codes.multiProduct, randomUUID());
    expect(other.valid).toBe(false);
    expect(other.reason).toMatch(/applicable/i);
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

  it('threads maxAmount through for PERCENT vouchers (cap must not be silently dropped)', async () => {
    const r = await service.validate(codes.cappedPercent, productAId);
    expect(r.valid).toBe(true);
    expect(r.type).toBe('PERCENT');
    expect(r.voucherAmount).toBe(50);
    // The bug: validate() dropped maxAmount, so computeTotals never capped the
    // discount. 50% of 500k = 250k, but the cap is 50k.
    expect(r.maxAmount).toBe(50_000);
  });

  it('atomic redeem: only one of two parallel redeems succeeds when quota=1', async () => {
    const v = await prisma.voucher.findUnique({ where: { code: codes.quotaOne } });
    expect(v).toBeTruthy();
    // Two DISTINCT orders racing for the last quota slot — exactly one wins.
    const [r1, r2] = await Promise.allSettled([
      service.redeem(v!.id, randomUUID()),
      service.redeem(v!.id, randomUUID()),
    ]);
    const ok = [r1, r2].filter((r) => r.status === 'fulfilled').length;
    const fail = [r1, r2].filter((r) => r.status === 'rejected').length;
    expect(ok).toBe(1);
    expect(fail).toBe(1);

    const after = await prisma.voucher.findUnique({ where: { id: v!.id } });
    expect(after?.used).toBe(1);
  });

  it('idempotent redeem: redelivering the same order does not double-count used', async () => {
    const v = await prisma.voucher.findUnique({ where: { code: codes.idempotent } });
    expect(v).toBeTruthy();
    const transactionId = randomUUID();
    // First delivery redeems; the redelivered webhook for the SAME order is a no-op.
    await service.redeem(v!.id, transactionId);
    await service.redeem(v!.id, transactionId);
    const after = await prisma.voucher.findUnique({ where: { id: v!.id } });
    expect(after?.used).toBe(1);
  });

  it('idempotent redeem: concurrent redelivery of the same order increments used once', async () => {
    const v = await prisma.voucher.findUnique({ where: { code: codes.idempotent } });
    expect(v).toBeTruthy();
    const before = (await prisma.voucher.findUnique({ where: { id: v!.id } }))!.used;
    const transactionId = randomUUID();
    // Two webhooks for the same order land at once — the unique slot serialises them.
    await Promise.allSettled([
      service.redeem(v!.id, transactionId),
      service.redeem(v!.id, transactionId),
    ]);
    const after = await prisma.voucher.findUnique({ where: { id: v!.id } });
    expect(after?.used).toBe(before + 1);
  });
});
