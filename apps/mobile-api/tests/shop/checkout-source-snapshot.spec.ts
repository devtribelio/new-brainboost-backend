/**
 * Tracking-link source snapshot on the order (shop web).
 *
 * The order freezes the source at submit precisely BECAUSE the shop cookie is
 * last-touch: a report that joined shop_visits by guest_id would retro-move a
 * paid order onto whatever campaign the buyer clicked next. The regression this
 * guards is the snapshot silently not being written, which is invisible until a
 * campaign report comes back empty.
 *
 * Requires a reachable Postgres test DB (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '@/app';
import { prisma } from '@bb/db';

describe('checkout — tracking-link source snapshot', () => {
  const app = buildApp();
  const ts = Date.now();
  const email = `shop-src-${ts}@test.local`;
  const password = 'secret123';
  let accessToken = '';
  let memberId = '';
  let productId = '';

  beforeAll(async () => {
    await request(app)
      .post('/api/member/auth/register')
      .send({ email, password, fullName: 'Shop Source Tester' });
    await prisma.member.update({
      where: { email },
      data: { isActive: true, isEmailVerified: true },
    });
    const tokenRes = await request(app)
      .post('/api/member/oauth/token')
      .send({ grant_type: 'password', username: email, password });
    accessToken = (tokenRes.body.data as { access_token: string }).access_token;
    memberId = (await prisma.member.findUniqueOrThrow({ where: { email } })).id;

    const product = await prisma.product.create({
      data: { type: 'course', title: `Shop Source ${ts}`, price: 300_000, isActive: true, status: 'active' },
    });
    productId = product.id;
  });

  afterAll(async () => {
    await prisma.commerceTransaction.deleteMany({ where: { memberId } });
    if (productId) await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.refreshToken.deleteMany({ where: { memberId } });
    await prisma.member.deleteMany({ where: { id: memberId } });
    await prisma.$disconnect();
  });

  async function submit(body: Record<string, unknown>) {
    return request(app)
      .post('/api/member/product/checkout/submit')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ productId, ...body });
  }

  it('freezes the submitted UTM + guestId on the order', async () => {
    const res = await submit({
      guestId: `gid-${ts}`,
      utmSource: 'webinar',
      utmMedium: 'email',
      utmCampaign: 'sep26',
      utmContent: 'banner-a',
      utmTerm: 'kelas-online',
    });
    expect(res.status).toBe(201);

    const txId = (res.body.data as { transactionId: string }).transactionId;
    const tx = await prisma.commerceTransaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.utmSource).toBe('webinar');
    expect(tx.utmMedium).toBe('email');
    expect(tx.utmCampaign).toBe('sep26');
    expect(tx.utmContent).toBe('banner-a');
    expect(tx.utmTerm).toBe('kelas-online');
    expect(tx.guestId).toBe(`gid-${ts}`);
    // Reporting only — the snapshot must never leak into the commission path.
    expect(tx.attributedAffiliatorMemberId).toBeNull();
  });

  it('leaves the columns NULL when no source is sent (report renders "direct")', async () => {
    await prisma.commerceTransaction.deleteMany({ where: { memberId } });
    const res = await submit({});
    expect(res.status).toBe(201);

    const txId = (res.body.data as { transactionId: string }).transactionId;
    const tx = await prisma.commerceTransaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.utmSource).toBeNull();
    expect(tx.guestId).toBeNull();
  });
});
