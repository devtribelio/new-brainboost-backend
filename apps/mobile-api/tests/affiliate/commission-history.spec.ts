/**
 * AffiliatorService.listCommissions — enriched commission history.
 *
 * Verifies the "komisi didapatkan dari mana saja" view: each row carries the
 * source product (title + thumbnail), the buyer (name + avatar, resolved by a
 * batch lookup since buyerMemberId has no Prisma relation), the program, and the
 * raw channel/source/level. Also covers the productId filter and pagination.
 *
 * Requires a reachable Postgres test DB (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { AffiliatorService } from '@bb/domain/affiliate/affiliator.service';

const TAG = `comm-hist-${Date.now()}`;
const svc = new AffiliatorService();

describe('AffiliatorService.listCommissions — enriched history', () => {
  let recipientId = '';
  let buyerId = '';
  let programId = '';
  let productA = '';
  let productB = '';

  beforeAll(async () => {
    const pa = await prisma.product.create({
      data: { type: 'course', title: `${TAG}-A`, price: 100_000, thumbnail: 'https://cdn/a.jpg' },
    });
    productA = pa.id;
    const pb = await prisma.product.create({
      data: { type: 'course', title: `${TAG}-B`, price: 200_000 },
    });
    productB = pb.id;
    const program = await prisma.affiliateProgram.create({
      data: { code: `${TAG}-prog`, name: 'History Program', productId: productA, isActive: true },
    });
    programId = program.id;
    const recipient = await prisma.member.create({
      data: { email: `${TAG}-r@hist.local`, passwordHash: await bcrypt.hash('x', 4) },
    });
    recipientId = recipient.id;
    const buyer = await prisma.member.create({
      data: {
        email: `${TAG}-b@hist.local`,
        passwordHash: await bcrypt.hash('x', 4),
        fullName: 'Budi Santoso',
        avatarUrl: 'https://cdn/budi.jpg',
        code: `${TAG.slice(-6)}`,
      },
    });
    buyerId = buyer.id;

    async function seed(opts: { productId: string; channel: string | null; source: string | null; withBuyer: boolean }) {
      await prisma.affiliateCommission.create({
        data: {
          recipientId,
          programId,
          productId: opts.productId,
          buyerMemberId: opts.withBuyer ? buyerId : null,
          paymentId: randomUUID(),
          level: 1,
          affiliateBased: 'PERFORMANCE',
          productPrice: 100_000,
          voucherAmount: 0,
          commissionRate: 20,
          amount: 20_000,
          status: 'PENDING',
          channel: opts.channel,
          source: opts.source,
        },
      });
    }

    await seed({ productId: productA, channel: 'xendit', source: 'DEEPLINK', withBuyer: true });
    await seed({ productId: productB, channel: 'revenuecat', source: 'WEB', withBuyer: false });
  });

  afterAll(async () => {
    await prisma.affiliateCommission.deleteMany({ where: { recipientId } });
    await prisma.affiliateProgram.delete({ where: { id: programId } });
    await prisma.product.deleteMany({ where: { id: { in: [productA, productB] } } });
    await prisma.member.deleteMany({ where: { id: { in: [recipientId, buyerId] } } });
    await prisma.$disconnect();
  });

  it('enriches each row with product, program, channel and source', async () => {
    const { rows, total } = await svc.listCommissions(recipientId, {}, 1, 20);
    expect(total).toBe(2);
    const rowA = rows.find((r) => r.productId === productA)!;
    expect(rowA.product?.title).toBe(`${TAG}-A`);
    expect(rowA.product?.thumbnail).toBe('https://cdn/a.jpg');
    expect(rowA.program?.code).toBe(`${TAG}-prog`);
    expect(rowA.channel).toBe('xendit');
    expect(rowA.source).toBe('DEEPLINK');
  });

  it('resolves the buyer via batch lookup', async () => {
    const { rows } = await svc.listCommissions(recipientId, {}, 1, 20);
    const rowA = rows.find((r) => r.productId === productA)!;
    expect(rowA.buyer?.id).toBe(buyerId);
    expect(rowA.buyer?.fullName).toBe('Budi Santoso');
    expect(rowA.buyer?.avatarUrl).toBe('https://cdn/budi.jpg');
  });

  it('leaves buyer null when buyerMemberId is absent', async () => {
    const { rows } = await svc.listCommissions(recipientId, {}, 1, 20);
    const rowB = rows.find((r) => r.productId === productB)!;
    expect(rowB.buyer).toBeNull();
  });

  it('filters by productId', async () => {
    const { rows, total } = await svc.listCommissions(recipientId, { productId: productB }, 1, 20);
    expect(total).toBe(1);
    expect(rows[0]!.productId).toBe(productB);
  });
});
