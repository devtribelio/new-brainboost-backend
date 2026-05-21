/**
 * Purchase ingestion kernel — end to end. Requires migration 20260521170000_ingestion_kernel
 * on the test DB. Exercises: affiliate-eligible channel pays the inviter, idempotency, and a
 * non-affiliate channel records the purchase WITHOUT paying commission (the triggersAffiliate toggle).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@/config/prisma';
import { registerCommerceListeners } from '@/modules/commerce/listeners/payment-success.listener';
import { purchaseIngestService } from '@/modules/ingest/purchase-ingest.service';
import { credentialService } from '@/modules/ingest/credential.service';

const TAG = `ingest-${Date.now()}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll for an async-listener side effect (commission) — robust to tunnel latency. */
async function waitForCommission(where: Record<string, unknown>, tries = 25, gap = 120) {
  for (let i = 0; i < tries; i++) {
    const c = await prisma.affiliateCommission.findFirst({ where });
    if (c) return c;
    await wait(gap);
  }
  return null;
}

describe('purchase ingestion kernel', () => {
  let inviterId = '';
  let buyerId = '';
  let productId = '';
  let keyAff = '';
  let keyNoAff = '';
  const memberIds: string[] = [];
  const credNames: string[] = [];

  beforeAll(async () => {
    registerCommerceListeners();
    const inviter = await prisma.member.create({
      data: { email: `${TAG}-inv@t.local`, passwordHash: await bcrypt.hash('x', 4), affiliateBased: 'PERFORMANCE' },
    });
    inviterId = inviter.id;
    memberIds.push(inviterId);
    const buyer = await prisma.member.create({
      data: { email: `${TAG}-buy@t.local`, passwordHash: await bcrypt.hash('x', 4), inviterId },
    });
    buyerId = buyer.id;
    memberIds.push(buyerId);
    const product = await prisma.product.create({
      data: { type: 'course', title: `${TAG}-p`, price: 0, iapProductId: `${TAG}-sku` },
    });
    productId = product.id;
    const a = await credentialService.issue(`${TAG}-rc`, { triggersAffiliate: true });
    keyAff = a.key;
    credNames.push(a.name);
    const b = await credentialService.issue(`${TAG}-scalev`, { triggersAffiliate: false });
    keyNoAff = b.key;
    credNames.push(b.name);
  });

  afterAll(async () => {
    await prisma.affiliateCommission.deleteMany({ where: { buyerMemberId: buyerId } });
    await prisma.commercePayment.deleteMany({ where: { memberId: buyerId } });
    await prisma.commerceTransaction.deleteMany({ where: { memberId: buyerId } });
    await prisma.courseEnrollment.deleteMany({ where: { memberId: buyerId } });
    await prisma.thirdPartyCredential.deleteMany({ where: { name: { in: credNames } } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
    await prisma.$disconnect();
  });

  it('affiliate-eligible channel: purchase pays the buyer inviter (resolve product by SKU)', async () => {
    const cred = await credentialService.verify(keyAff);
    const res = await purchaseIngestService.ingest(
      {
        providerEventId: `${TAG}-evt1`,
        type: 'PURCHASE',
        memberRef: { byId: buyerId },
        productRef: { bySku: `${TAG}-sku` },
        grossAmount: 100_000,
      },
      cred!,
    );
    expect(res.status).toBe('committed');
    const comm = await waitForCommission({
      recipientId: inviterId,
      buyerMemberId: buyerId,
      paymentId: res.paymentId,
    });
    expect(comm).not.toBeNull();
    expect(comm?.amount).toBe(20_000); // PERFORMANCE tier 1 (20%)
  });

  it('idempotent: same providerEventId → duplicate, no second commission', async () => {
    const cred = await credentialService.verify(keyAff);
    const res = await purchaseIngestService.ingest(
      {
        providerEventId: `${TAG}-evt1`,
        type: 'PURCHASE',
        memberRef: { byId: buyerId },
        productRef: { bySku: `${TAG}-sku` },
        grossAmount: 100_000,
      },
      cred!,
    );
    expect(res.status).toBe('duplicate');
    const count = await prisma.affiliateCommission.count({
      where: { recipientId: inviterId, buyerMemberId: buyerId },
    });
    expect(count).toBe(1);
  });

  it('non-affiliate channel (triggersAffiliate=false): purchase recorded, NO commission', async () => {
    const cred = await credentialService.verify(keyNoAff);
    const res = await purchaseIngestService.ingest(
      {
        providerEventId: `${TAG}-evt2`,
        type: 'PURCHASE',
        memberRef: { byEmail: `${TAG}-buy@t.local` },
        productRef: { byId: productId },
        grossAmount: 50_000,
      },
      cred!,
    );
    expect(res.status).toBe('committed');
    await wait(250);
    const comm = await prisma.affiliateCommission.findFirst({
      where: { buyerMemberId: buyerId, paymentId: res.paymentId },
    });
    expect(comm).toBeNull(); // toggle off → enrollment-only, no commission
  });
});
