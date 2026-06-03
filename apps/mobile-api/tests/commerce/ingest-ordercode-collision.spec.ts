import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@bb/db';

// Force a deterministic order-code collision: the first generateOrderCode call
// returns a code we pre-occupy (→ `code` P2002 inside the ingest transaction),
// the retry returns a fresh one. Proves the ingest distinguishes a code
// collision (retry) from a genuine idempotency duplicate (drop) — the bug was
// that ANY P2002 was treated as duplicate, silently dropping a paid purchase.
const h = vi.hoisted(() => ({ queue: [] as string[] }));
vi.mock('@bb/domain/commerce/utils/generate-order-code', () => ({
  generateOrderCode: vi.fn(async () => h.queue.shift() ?? `BB-FALLBACK-${h.queue.length}`),
}));

import { purchaseIngestService } from '@/modules/ingest/purchase-ingest.service';
import type { VerifiedCredential } from '@/modules/ingest/credential.service';

const TS = Date.now();
const OCCUPIED = `BB-OCCUPIED-${TS}`;
const FRESH = `BB-FRESH-${TS}`;

const cred: VerifiedCredential = {
  id: '00000000-0000-0000-0000-000000000000',
  name: 'revenuecat',
  triggersAffiliate: false,
  canIngestRefund: false,
};

describe('PurchaseIngestService order-code collision', () => {
  let memberId = '';
  let productId = '';

  beforeAll(async () => {
    const member = await prisma.member.create({
      data: { email: `collide-${TS}@test.local`, passwordHash: 'x', fullName: 'Collide Tester' },
    });
    memberId = member.id;
    const product = await prisma.product.create({
      data: { type: 'course', title: 'Collide Course', price: 10_000, isActive: false, status: 'inactive', course: { create: {} } },
    });
    productId = product.id;

    // Occupy the code the first attempt will request.
    await prisma.commerceTransaction.create({
      data: {
        code: OCCUPIED,
        memberId,
        productId,
        itemTotal: 0,
        amount: 0,
        voucherAmount: 0,
        provider: `occupier-${TS}`,
        providerEventId: `occ-${TS}`,
        status: 'PAID',
        paidAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await prisma.commercePaymentEvent.deleteMany({ where: { payment: { memberId } } });
    await prisma.commercePayment.deleteMany({ where: { memberId } });
    await prisma.commerceTransaction.deleteMany({ where: { memberId } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.$disconnect();
  });

  it('retries on a code collision and commits (not dropped as duplicate)', async () => {
    h.queue.length = 0;
    h.queue.push(OCCUPIED, FRESH); // 1st attempt collides, 2nd succeeds

    const res = await purchaseIngestService.ingest(
      {
        providerEventId: `evt-${TS}`,
        type: 'PURCHASE',
        memberRef: { byId: memberId },
        productRef: { byId: productId },
        grossAmount: 10_000,
      },
      cred,
    );

    expect(res.status).toBe('committed');
    expect(res.transactionId).toBeTruthy();

    const tx = await prisma.commerceTransaction.findUnique({
      where: { id: res.transactionId! },
      select: { code: true, status: true },
    });
    expect(tx?.code).toBe(FRESH); // committed with the jittered/retry code
    expect(tx?.status).toBe('PAID');
  });
});
