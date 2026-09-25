/**
 * Auto-provision-on-ingest (M1). A credential flagged `canProvisionMember` creates a
 * Brainboost Member for a purchase whose buyer has no account yet, keyed on the email;
 * an unflagged credential keeps the original member_not_found behaviour. Requires the
 * ingestion-kernel tables + the can_provision_member column on the test DB.
 *
 * Real-DB style, matching tests/ingest/ingest.spec.ts (prisma against the test DB).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@bb/db';
import { memberProvisioningService } from '@bb/domain/member/provisioning.service';
import { registerCommerceListeners } from '@bb/domain/commerce/listeners/payment-success.listener';
import { purchaseIngestService } from '@/modules/ingest/purchase-ingest.service';
import { credentialService } from '@/modules/ingest/credential.service';

const TAG = `prov-${Date.now()}`;

describe('purchase ingestion: member auto-provisioning', () => {
  let productId = '';
  let keyProvision = '';
  let keyNoProvision = '';
  const credNames: string[] = [];
  const emails: string[] = [];

  /** Delete any members created for the given email (provisioned + their commerce rows). */
  async function cleanupEmail(email: string) {
    const m = await prisma.member.findUnique({ where: { email }, select: { id: true } });
    if (!m) return;
    await prisma.commercePaymentEvent.deleteMany({ where: { payment: { memberId: m.id } } });
    await prisma.commercePayment.deleteMany({ where: { memberId: m.id } });
    await prisma.commerceTransaction.deleteMany({ where: { memberId: m.id } });
    await prisma.networkMember.deleteMany({ where: { memberId: m.id } });
    await prisma.member.delete({ where: { id: m.id } });
  }

  beforeAll(async () => {
    registerCommerceListeners();
    const product = await prisma.product.create({
      data: { type: 'course', title: `${TAG}-p`, price: 100_000, iosProductId: `${TAG}-sku` },
    });
    productId = product.id;
    const p = await credentialService.issue(`${TAG}-scalev-on`, { canProvisionMember: true });
    keyProvision = p.key;
    credNames.push(p.name);
    const q = await credentialService.issue(`${TAG}-scalev-off`, { canProvisionMember: false });
    keyNoProvision = q.key;
    credNames.push(q.name);
  });

  afterAll(async () => {
    for (const e of emails) await cleanupEmail(e);
    await prisma.thirdPartyCredential.deleteMany({ where: { name: { in: credNames } } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.$disconnect();
  });

  it('(a) existing member matched → no provision, purchase attributed to the existing id', async () => {
    const email = `${TAG}-existing@t.local`;
    emails.push(email);
    const existing = await prisma.member.create({ data: { email, passwordHash: 'x' } });

    const before = await prisma.member.count();
    const cred = await credentialService.verify(keyProvision);
    const res = await purchaseIngestService.ingest(
      {
        providerEventId: `${TAG}-a`,
        type: 'PURCHASE',
        memberRef: { byEmail: email, name: 'Should Be Ignored' },
        productRef: { byId: productId },
        grossAmount: 100_000,
      },
      cred!,
    );

    expect(res.status).toBe('committed');
    expect(await prisma.member.count()).toBe(before); // no new member row
    const tx = await prisma.commerceTransaction.findUnique({
      where: { id: res.transactionId! },
      select: { memberId: true },
    });
    expect(tx?.memberId).toBe(existing.id);
    // Existing profile untouched by the ignored memberRef.name.
    const m = await prisma.member.findUnique({ where: { id: existing.id }, select: { fullName: true } });
    expect(m?.fullName).toBeNull();
  });

  it('(b) member_not_found + flag ON + email → member created and transaction committed', async () => {
    const email = `${TAG}-new@t.local`;
    emails.push(email);
    expect(await prisma.member.findUnique({ where: { email } })).toBeNull();

    const cred = await credentialService.verify(keyProvision);
    const res = await purchaseIngestService.ingest(
      {
        providerEventId: `${TAG}-b`,
        type: 'PURCHASE',
        memberRef: { byEmail: email.toUpperCase(), name: 'New Buyer', phone: '8123456789', phoneCode: '+62' },
        productRef: { byId: productId },
        grossAmount: 100_000,
      },
      cred!,
    );

    expect(res.status).toBe('committed');
    const created = await prisma.member.findUnique({ where: { email } });
    expect(created).not.toBeNull();
    // Field defaults for a Scalev-provisioned member.
    expect(created!.isActive).toBe(true);
    expect(created!.isEmailVerified).toBe(false);
    expect(created!.passwordAlgo).toBe('social');
    expect(created!.fullName).toBe('New Buyer');
    expect(created!.phone).toBe('8123456789');
    expect(created!.phoneCode).toBe('+62');
    expect(created!.code).toBeTruthy();
    expect(created!.affiliateCode).toBe(created!.code);
    expect(created!.username).toBeTruthy();
    // Transaction is attributed to the newly-created member.
    const tx = await prisma.commerceTransaction.findUnique({
      where: { id: res.transactionId! },
      select: { memberId: true },
    });
    expect(tx?.memberId).toBe(created!.id);
  });

  it('(c) flag OFF → still member_not_found, no member created', async () => {
    const email = `${TAG}-off@t.local`;
    const before = await prisma.member.count();
    const cred = await credentialService.verify(keyNoProvision);
    const res = await purchaseIngestService.ingest(
      {
        providerEventId: `${TAG}-c`,
        type: 'PURCHASE',
        memberRef: { byEmail: email, name: 'Nope' },
        productRef: { byId: productId },
        grossAmount: 100_000,
      },
      cred!,
    );

    expect(res.status).toBe('member_not_found');
    expect(await prisma.member.findUnique({ where: { email } })).toBeNull();
    expect(await prisma.member.count()).toBe(before);
  });

  it('(d) flag ON but no email → member_not_found, no member created', async () => {
    const before = await prisma.member.count();
    const cred = await credentialService.verify(keyProvision);
    const res = await purchaseIngestService.ingest(
      {
        providerEventId: `${TAG}-d`,
        type: 'PURCHASE',
        // No byEmail, and a byId that resolves to nothing.
        memberRef: { byId: '00000000-0000-0000-0000-000000000000', name: 'No Email' },
        productRef: { byId: productId },
        grossAmount: 100_000,
      },
      cred!,
    );

    expect(res.status).toBe('member_not_found');
    expect(await prisma.member.count()).toBe(before);
  });

  it('(e) unique-race: email created concurrently → re-resolves to the existing member', async () => {
    const email = `${TAG}-race@t.local`;
    emails.push(email);
    // Simulate the race: the row already exists by the time provisionMember runs, so
    // member.create hits the email-unique constraint (P2002) and the ingest path
    // re-resolves by email instead of failing.
    const racer = await prisma.member.create({ data: { email, passwordHash: 'x' } });

    const before = await prisma.member.count();
    const cred = await credentialService.verify(keyProvision);
    // resolveMember would normally find it first; assert the provisioning method's own
    // race guard directly so the re-resolution branch is what is exercised.
    const viaGuard = await (
      purchaseIngestService as unknown as {
        provisionMember: (
          ref: { byEmail?: string; name?: string },
          c: typeof cred,
        ) => Promise<string | null>;
      }
    ).provisionMember({ byEmail: email, name: 'Racer' }, cred!);

    expect(viaGuard).toBe(racer.id);
    expect(await prisma.member.count()).toBe(before); // no duplicate created

    // And the full ingest path still commits, attributed to the existing row.
    const res = await purchaseIngestService.ingest(
      {
        providerEventId: `${TAG}-e`,
        type: 'PURCHASE',
        memberRef: { byEmail: email, name: 'Racer' },
        productRef: { byId: productId },
        grossAmount: 100_000,
      },
      cred!,
    );
    expect(res.status).toBe('committed');
    const tx = await prisma.commerceTransaction.findUnique({
      where: { id: res.transactionId! },
      select: { memberId: true },
    });
    expect(tx?.memberId).toBe(racer.id);
  });

  it('provisionMember helper creates a unique code/username and auto-joins networks', async () => {
    const email = `${TAG}-helper@t.local`;
    emails.push(email);
    const m = await memberProvisioningService.provisionMember({
      data: { email, isActive: true, isEmailVerified: false },
    });
    expect(m.code).toBeTruthy();
    expect(m.affiliateCode).toBe(m.code);
    expect(m.username).toBeTruthy();
    expect(m.passwordAlgo).toBe('social');
  });
});
