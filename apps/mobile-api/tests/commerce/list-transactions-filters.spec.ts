import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@bb/db';
import { PaymentService } from '@bb/domain/commerce/payment.service';
import { createTestMember, createTestProduct } from './fixtures';

const svc = new PaymentService();

let memberId: string;
let productId: string;
const productIds: string[] = [];
const txIds: string[] = [];

async function seedTxn(opts: {
  productId: string;
  status: 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELED';
  createdAt: Date;
}) {
  const ts = Date.now() + Math.floor(Math.random() * 1_000_000);
  const tx = await prisma.commerceTransaction.create({
    data: {
      code: `TEST-${ts}`,
      memberId,
      productId: opts.productId,
      qty: 1,
      itemTotal: 100_000,
      amount: 100_000,
      status: opts.status,
      createdAt: opts.createdAt,
    },
  });
  txIds.push(tx.id);
  return tx;
}

describe('PaymentService.listTransactions filters', () => {
  beforeAll(async () => {
    const m = await createTestMember('txn-filter');
    memberId = m.id;
    const pA = await createTestProduct('React Fundamentals', 100_000);
    const pB = await createTestProduct('Vue Advanced', 200_000);
    productId = pA.id;
    productIds.push(pA.id, pB.id);
    await seedTxn({ productId: pA.id, status: 'PAID', createdAt: new Date('2026-05-01T10:00:00Z') });
    await seedTxn({ productId: pA.id, status: 'PENDING', createdAt: new Date('2026-05-10T10:00:00Z') });
    await seedTxn({
      productId: pB.id,
      status: 'CANCELED',
      createdAt: new Date('2026-05-15T10:00:00Z'),
    });
    await seedTxn({ productId: pB.id, status: 'EXPIRED', createdAt: new Date('2026-05-20T10:00:00Z') });
  });

  afterAll(async () => {
    await prisma.commerceTransaction.deleteMany({ where: { id: { in: txIds } } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  });

  it('no filters → all 4', async () => {
    const r = await svc.listTransactions(memberId, 1, 50);
    expect(r.total).toBe(4);
    expect(r.rows.length).toBe(4);
  });

  it('status filter (single)', async () => {
    const r = await svc.listTransactions(memberId, 1, 50, { status: ['PAID'] });
    expect(r.total).toBe(1);
    expect(r.rows[0].status).toBe('PAID');
  });

  it('status filter (multi — CANCELED + EXPIRED collapsed by FE)', async () => {
    const r = await svc.listTransactions(memberId, 1, 50, { status: ['CANCELED', 'EXPIRED'] });
    expect(r.total).toBe(2);
    expect(r.rows.every((t) => t.status === 'CANCELED' || t.status === 'EXPIRED')).toBe(true);
  });

  it('search by product title (case-insensitive substring)', async () => {
    const r = await svc.listTransactions(memberId, 1, 50, { search: 'react' });
    expect(r.total).toBe(2);
    expect(r.rows.every((t) => t.productId === productId)).toBe(true);
  });

  it('createdFrom / createdTo inclusive range', async () => {
    const r = await svc.listTransactions(memberId, 1, 50, {
      createdFrom: new Date('2026-05-10T00:00:00Z'),
      createdTo: new Date('2026-05-15T23:59:59Z'),
    });
    expect(r.total).toBe(2);
  });

  it('combined filters', async () => {
    const r = await svc.listTransactions(memberId, 1, 50, {
      status: ['CANCELED', 'EXPIRED'],
      search: 'vue',
      createdFrom: new Date('2026-05-14T00:00:00Z'),
    });
    expect(r.total).toBe(2);
  });
});
