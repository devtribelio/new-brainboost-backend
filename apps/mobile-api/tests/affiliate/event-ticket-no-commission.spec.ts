/**
 * Event tickets pay no affiliate commission yet (PRD P4).
 *
 * The rule needs a test precisely because the PRD got it wrong: it assumed tickets
 * would be silent because they carry no `affiliate_programs` row. A program is not
 * what opens that path — Option B makes every product affiliate-able and gates on
 * the buyer's inviter instead — so a ticket bought by anyone with an inviter was
 * paying them the course rate, and nothing anywhere said so.
 *
 * Requires a reachable Postgres test DB (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { AffiliatorService } from '@bb/domain/affiliate/affiliator.service';
import { EVENT_TICKET_PRODUCT_TYPE } from '@bb/domain/event/order';

const TAG = `ticket-comm-${Date.now()}`;
const svc = new AffiliatorService();

describe('affiliate commission — event tickets', () => {
  const memberIds: string[] = [];
  const productIds: string[] = [];
  let ticketProductId = '';
  let courseProductId = '';
  let inviter = '';
  let buyer = '';

  async function mkMember(inviterId: string | null): Promise<string> {
    const m = await prisma.member.create({
      data: {
        email: `${TAG}-${randomUUID()}@t.local`,
        passwordHash: await bcrypt.hash('x', 4),
        affiliateBased: 'PERFORMANCE',
        inviterId,
      },
    });
    memberIds.push(m.id);
    return m.id;
  }

  beforeAll(async () => {
    const ticket = await prisma.product.create({
      data: { type: EVENT_TICKET_PRODUCT_TYPE, title: `${TAG}-ticket`, price: 0 },
    });
    const course = await prisma.product.create({
      data: { type: 'course', title: `${TAG}-course`, price: 0 },
    });
    ticketProductId = ticket.id;
    courseProductId = course.id;
    productIds.push(ticket.id, course.id);

    inviter = await mkMember(null);
    buyer = await mkMember(inviter);
  });

  afterAll(async () => {
    await prisma.affiliateCommission.deleteMany({ where: { buyerMemberId: buyer } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    if (memberIds.length) await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
    await prisma.$disconnect();
  });

  it('pays nothing on a ticket, even when the buyer has an inviter', async () => {
    const paymentId = randomUUID();
    const res = await svc.commitCommissionsForPayment({
      paymentId,
      productId: ticketProductId,
      productPrice: 200_000,
      voucherAmount: 0,
      buyerMemberId: buyer,
      programId: null,
    });

    expect(res.committed).toBe(0);
    expect(await prisma.affiliateCommission.count({ where: { paymentId } })).toBe(0);
  });

  it('pays nothing on a ticket bought through an affiliate link either', async () => {
    // The per-purchase override is the other way in. Closing one and not the other
    // would leave tickets paying commission to exactly the people who promote them.
    const linkOwner = await mkMember(null);
    const paymentId = randomUUID();
    const res = await svc.commitCommissionsForPayment({
      paymentId,
      productId: ticketProductId,
      productPrice: 200_000,
      voucherAmount: 0,
      buyerMemberId: buyer,
      programId: null,
      overrideAffiliatorMemberId: linkOwner,
    });

    expect(res.committed).toBe(0);
    expect(await prisma.affiliateCommission.count({ where: { paymentId } })).toBe(0);
  });

  it('still pays on a course, so the block is about tickets and not about commission', async () => {
    const paymentId = randomUUID();
    const res = await svc.commitCommissionsForPayment({
      paymentId,
      productId: courseProductId,
      productPrice: 100_000,
      voucherAmount: 0,
      buyerMemberId: buyer,
      programId: null,
    });

    expect(res.committed).toBe(1);
    const [row] = await prisma.affiliateCommission.findMany({ where: { paymentId } });
    expect(row?.recipientId).toBe(inviter);
  });
});
