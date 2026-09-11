import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@bb/db';
import { PaymentService } from '@bb/domain/commerce/payment.service';
import { EVENT_TICKET_PRODUCT_TYPE } from '@bb/domain/event/order';
import { createTestMember, createTestProduct, createPendingTransaction } from './fixtures';

/**
 * A client listing "my purchases" has to route an event order somewhere other than
 * course content — its tickets live under the event. `product.type` is what tells it
 * apart, and it is the product row's own column rather than a second flag that could
 * disagree with it.
 */
const svc = new PaymentService();

let memberId: string;
const productIds: string[] = [];
let courseTxId = '';
let eventTxId = '';

describe('transaction product type', () => {
  beforeAll(async () => {
    const m = await createTestMember('txn-type');
    memberId = m.id;

    const course = await createTestProduct('React Fundamentals', 100_000);
    const ticket = await prisma.product.create({
      data: {
        type: EVENT_TICKET_PRODUCT_TYPE,
        title: 'Founders Summit — Early Bird',
        price: 200_000,
        isActive: true,
        status: 'active',
      },
    });
    productIds.push(course.id, ticket.id);

    courseTxId = (await createPendingTransaction(memberId, course.id, 100_000)).id;
    eventTxId = (await createPendingTransaction(memberId, ticket.id, 200_000)).id;
  });

  afterAll(async () => {
    await prisma.commerceTransaction.deleteMany({ where: { memberId } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  });

  it('marks an event order on the detail endpoint', async () => {
    const tx = await svc.getTransactionStatus(memberId, eventTxId);
    expect(tx.product.type).toBe('event_ticket');
  });

  it('leaves a course order saying what it is', async () => {
    const tx = await svc.getTransactionStatus(memberId, courseTxId);
    expect(tx.product.type).toBe('course');
  });

  it('carries the type on every row of the list too', async () => {
    const { rows } = await svc.listTransactions(memberId, 1, 50);
    const byId = new Map(rows.map((r) => [r.id, r.product.type]));

    expect(byId.get(eventTxId)).toBe('event_ticket');
    expect(byId.get(courseTxId)).toBe('course');
    // Both endpoints answer the same question the same way — a client that has to
    // ask twice, differently, gets it wrong on one of them.
    expect(rows.every((r) => typeof r.product.type === 'string')).toBe(true);
  });
});
