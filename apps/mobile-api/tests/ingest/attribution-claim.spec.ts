/**
 * B-2: commission "first settle wins" per (provider, attributionKey).
 *
 * Guards the IAP over-attribution bug where a re-settle of the SAME underlying
 * purchase (delete+rebuy / renewal / restore / RC re-sync burst) arrives with a
 * fresh providerEventId → fresh paymentId → the per-payment commission dedup
 * can't see it → duplicate commission. The unique AffiliateAttributionClaim row
 * makes only the first settle commission-bearing.
 *
 * Requires the test DB to have migrated `affiliate_attribution_claims` +
 * `commerce_transactions.attribution_key`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { registerCommerceListeners } from '@bb/domain/commerce/listeners/payment-success.listener';
import { purchaseIngestService } from '@/modules/ingest/purchase-ingest.service';
import { credentialService } from '@/modules/ingest/credential.service';

const TAG = `claim-${Date.now()}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForCommission(where: Record<string, unknown>, tries = 25, gap = 120) {
  for (let i = 0; i < tries; i++) {
    const c = await prisma.affiliateCommission.findFirst({ where });
    if (c) return c;
    await wait(gap);
  }
  return null;
}

describe('ingest commission claim (B-2: first settle wins per attributionKey)', () => {
  let inviterId = '';
  let buyerId = '';
  let productId = '';
  let key = '';
  const memberIds: string[] = [];
  const credNames: string[] = [];
  const ORIGINAL_TXN = `${TAG}-otxn`;

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
      data: { type: 'course', title: `${TAG}-p`, price: 0, iosProductId: `${TAG}-sku` },
    });
    productId = product.id;
    const c = await credentialService.issue(`${TAG}-rc`, { triggersAffiliate: true });
    key = c.key;
    credNames.push(c.name);
  });

  afterAll(async () => {
    await prisma.affiliateCommission.deleteMany({ where: { buyerMemberId: buyerId } });
    await prisma.affiliateAttributionClaim.deleteMany({ where: { attributionKey: ORIGINAL_TXN } });
    await prisma.commercePayment.deleteMany({ where: { memberId: buyerId } });
    await prisma.commerceTransaction.deleteMany({ where: { memberId: buyerId } });
    await prisma.courseEnrollment.deleteMany({ where: { memberId: buyerId } });
    await prisma.thirdPartyCredential.deleteMany({ where: { name: { in: credNames } } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
    await prisma.$disconnect();
  });

  it('first settle pays the inviter once', async () => {
    const cred = await credentialService.verify(key);
    const res = await purchaseIngestService.ingest(
      {
        providerEventId: `${TAG}-evt-first`,
        attributionKey: ORIGINAL_TXN,
        type: 'PURCHASE',
        memberRef: { byId: buyerId },
        productRef: { bySku: `${TAG}-sku` },
        grossAmount: 100_000,
      },
      cred!,
    );
    expect(res.status).toBe('committed');
    const comm = await waitForCommission({ recipientId: inviterId, buyerMemberId: buyerId, paymentId: res.paymentId });
    expect(comm).not.toBeNull();
    expect(comm?.amount).toBe(20_000); // PERFORMANCE tier 1 (20%)
  });

  it('re-settle (new providerEventId, SAME attributionKey) records the txn but pays NO new commission', async () => {
    const cred = await credentialService.verify(key);
    const res = await purchaseIngestService.ingest(
      {
        providerEventId: `${TAG}-evt-resettle`, // delete+rebuy → fresh txn id
        attributionKey: ORIGINAL_TXN, // ...but same Apple original_transaction_id
        type: 'PURCHASE',
        memberRef: { byId: buyerId },
        productRef: { bySku: `${TAG}-sku` },
        grossAmount: 100_000,
      },
      cred!,
    );
    // A genuinely new transaction row is created (not a dup of providerEventId)…
    expect(res.status).toBe('committed');
    expect(res.paymentId).toBeTruthy();
    await wait(400);
    // …but commission was NOT paid for this second payment.
    const dup = await prisma.affiliateCommission.findFirst({
      where: { buyerMemberId: buyerId, paymentId: res.paymentId },
    });
    expect(dup).toBeNull();
    // Exactly one commission across both settles.
    const total = await prisma.affiliateCommission.count({
      where: { recipientId: inviterId, buyerMemberId: buyerId },
    });
    expect(total).toBe(1);
  });
});
