/**
 * BE-19 — HTTP module /subscription over the real app (supertest + OAuth):
 * public plans list; /me for owner/member/none; invite→claim→leave and
 * owner-remove flows; error envelopes (invalid code 400, unauthenticated 401);
 * web cancel (intent set, idempotent, canceled event) vs RC-sourced cancel
 * (400 pointing to the store). Real Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { buildApp } from '@/app';
import { prisma } from '@bb/db';
import { SubscriptionService } from '@bb/domain/subscription/subscription.service';

const app = buildApp();
const subscriptionService = new SubscriptionService();
const uniq = randomUUID().slice(0, 8);
const PASSWORD = 'secret123';

let ownerEmail: string;
let guestEmail: string;
let noneEmail: string;
let ownerId: string;
let guestId: string;
let duoProductId: string;
let soloProductId: string;

async function makeMember(tag: string): Promise<{ id: string; email: string }> {
  const email = `shttp-${tag}-${uniq}@test.local`;
  const m = await prisma.member.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      fullName: `SHTTP ${tag}`,
      isActive: true,
      isEmailVerified: true,
    },
  });
  return { id: m.id, email };
}

async function login(email: string): Promise<string> {
  const res = await request(app)
    .post('/api/member/oauth/token')
    .send({ grant_type: 'password', username: email, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data.access_token as string;
}

async function makePlanProduct(tag: string, seatCount: number, sortOrder: number) {
  const p = await prisma.product.create({
    data: {
      type: 'subscription',
      code: `TSTH-${tag}-${uniq}`,
      title: `HTTP ${tag}`,
      price: 999_000,
      isActive: true,
      status: 'active',
      iosProductId: `com.brainboost.ios.tsth_${tag.toLowerCase()}_${uniq}`,
      androidProductId: `com.brainboost.android.tsth_${tag.toLowerCase()}_${uniq}`,
      iosPrice: 1_099_000,
    },
  });
  await prisma.subscriptionPlan.create({
    data: {
      productId: p.id,
      code: `TSTH_${tag}_${uniq}`,
      tier: tag,
      periodMonths: 12,
      seatCount,
      affiliateRate: 40,
      renewalAffiliateRate: 20,
      sortOrder,
    },
  });
  return p.id;
}

async function cleanup() {
  const memberIds = (
    await prisma.member.findMany({ where: { email: { contains: uniq } }, select: { id: true } })
  ).map((m) => m.id);
  await prisma.notification.deleteMany({ where: { memberId: { in: memberIds } } });
  await prisma.refreshToken.deleteMany({ where: { memberId: { in: memberIds } } });
  await prisma.device.deleteMany({ where: { memberId: { in: memberIds } } });
  const subs = await prisma.memberSubscription.findMany({
    where: { ownerId: { in: memberIds } },
    select: { id: true },
  });
  await prisma.memberSubscription.deleteMany({ where: { id: { in: subs.map((s) => s.id) } } });
  await prisma.subscriptionPlan.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.product.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
}

beforeAll(async () => {
  await cleanup();
  ({ id: ownerId, email: ownerEmail } = await makeMember('owner'));
  ({ id: guestId, email: guestEmail } = await makeMember('guest'));
  ({ email: noneEmail } = await makeMember('none'));
  duoProductId = await makePlanProduct('DUO', 2, 90);
  soloProductId = await makePlanProduct('SOLO', 1, 91);

  await subscriptionService.activateFromPayment({
    ownerId,
    productId: duoProductId,
    transactionId: randomUUID(),
    source: 'xendit',
  });
});

afterAll(cleanup);

describe('/subscription HTTP module (BE-19)', () => {
  it('GET /plans is public, ordered, and carries productId + price for checkout', async () => {
    const r = await request(app).get('/api/subscription/plans');
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    const ours = (r.body.data as Array<{ planCode: string; productId: string; price: number }>)
      .filter((p) => p.planCode.includes(uniq));
    expect(ours.map((p) => p.planCode)).toEqual([`TSTH_DUO_${uniq}`, `TSTH_SOLO_${uniq}`]);
    expect(ours[0].productId).toBe(duoProductId);
    expect(ours[0].price).toBe(999_000);
    // IAP purchase-path fields (BB-95 addition)
    expect(ours[0]).toMatchObject({
      iosProductId: `com.brainboost.ios.tsth_duo_${uniq}`,
      androidProductId: `com.brainboost.android.tsth_duo_${uniq}`,
      iosPrice: 1_099_000,
    });
  });

  it('GET /me requires auth; returns none / owner-with-seats / member-with-own-seat', async () => {
    expect((await request(app).get('/api/subscription/me')).status).toBe(401);

    const noneToken = await login(noneEmail);
    const none = await request(app)
      .get('/api/subscription/me')
      .set('authorization', `Bearer ${noneToken}`);
    expect(none.body.data).toEqual({ role: 'none' });

    const ownerToken = await login(ownerEmail);
    const owner = await request(app)
      .get('/api/subscription/me')
      .set('authorization', `Bearer ${ownerToken}`);
    expect(owner.body.data).toMatchObject({
      role: 'owner',
      status: 'ACTIVE',
      tier: 'DUO',
      renewal: { productId: duoProductId },
    });
    expect(owner.body.data.seats).toHaveLength(2);
    expect(owner.body.data.seats[0]).toMatchObject({ seatNo: 1, claimed: true, isMe: true });
  });

  it('invite → claim → member /me → leave, all over HTTP', async () => {
    const ownerToken = await login(ownerEmail);
    const guestToken = await login(guestEmail);

    const inv = await request(app)
      .post('/api/subscription/seats/invite')
      .set('authorization', `Bearer ${ownerToken}`);
    expect(inv.status).toBe(200);
    expect(inv.body.data.seatNo).toBe(2);
    const code = inv.body.data.inviteCode as string;

    const badClaim = await request(app)
      .post('/api/subscription/seats/claim')
      .set('authorization', `Bearer ${guestToken}`)
      .send({ code: 'NOPE123456' });
    expect(badClaim.status).toBe(400);
    expect(badClaim.body.success).toBe(false);

    const claim = await request(app)
      .post('/api/subscription/seats/claim')
      .set('authorization', `Bearer ${guestToken}`)
      .send({ code });
    expect(claim.status).toBe(200);
    expect(claim.body.data).toMatchObject({ seatNo: 2, claimed: true, isMe: true });

    const me = await request(app)
      .get('/api/subscription/me')
      .set('authorization', `Bearer ${guestToken}`);
    expect(me.body.data).toMatchObject({ role: 'member', tier: 'DUO' });
    expect(me.body.data.seat).toMatchObject({ seatNo: 2, isMe: true });
    expect(me.body.data.seats).toBeUndefined(); // guests don't see the roster

    const leave = await request(app)
      .post('/api/subscription/seats/leave')
      .set('authorization', `Bearer ${guestToken}`);
    expect(leave.status).toBe(200);

    const after = await request(app)
      .get('/api/subscription/me')
      .set('authorization', `Bearer ${guestToken}`);
    expect(after.body.data.role).toBe('none');
  });

  it('owner removes a claimed seat via DELETE /seats/:seatId', async () => {
    const ownerToken = await login(ownerEmail);
    const guestToken = await login(guestEmail);

    const inv = await request(app)
      .post('/api/subscription/seats/invite')
      .set('authorization', `Bearer ${ownerToken}`);
    await request(app)
      .post('/api/subscription/seats/claim')
      .set('authorization', `Bearer ${guestToken}`)
      .send({ code: inv.body.data.inviteCode });

    const sub = await prisma.memberSubscription.findFirstOrThrow({ where: { ownerId } });
    const seat = await prisma.subscriptionSeat.findFirstOrThrow({
      where: { subscriptionId: sub.id, memberId: guestId },
    });

    // guest cannot remove (403), owner can
    const forbidden = await request(app)
      .delete(`/api/subscription/seats/${seat.id}`)
      .set('authorization', `Bearer ${guestToken}`);
    expect(forbidden.status).toBe(403);

    const removed = await request(app)
      .delete(`/api/subscription/seats/${seat.id}`)
      .set('authorization', `Bearer ${ownerToken}`);
    expect(removed.status).toBe(200);
    expect(
      (await prisma.subscriptionSeat.findUniqueOrThrow({ where: { id: seat.id } })).memberId,
    ).toBeNull();

    // Being removed by hand used to be the one way of losing a seat that told
    // the member nothing — tier change and expiry both notify.
    await new Promise((r) => setTimeout(r, 250));
    const notifs = await prisma.notification.findMany({
      where: { memberId: guestId, type: 'subscriptionSeatRemoved' },
    });
    expect(notifs).toHaveLength(1);
    // Must not blame the plan: the tier did not change, a person decided.
    expect(notifs[0].body).toContain('tidak tergabung');
    expect(notifs[0].body).not.toContain('berubah jadi');
  });

  it('declare → /me shows it → choose seats → cancel, all answering the /me shape', async () => {
    const ownerToken = await login(ownerEmail);
    const auth = (r: request.Test) => r.set('authorization', `Bearer ${ownerToken}`);

    const declared = await auth(
      request(app).post('/api/subscription/pending').send({ planCode: `TSTH_SOLO_${uniq}` }),
    );
    expect(declared.status).toBe(200);
    expect(declared.body.data.pendingChange).toMatchObject({
      planCode: `TSTH_SOLO_${uniq}`,
      tier: 'SOLO',
      seatCount: 1,
      canCancel: true, // web-declared, so we own the revert
    });
    // Nothing about the running term moved.
    expect(declared.body.data.planCode).toBe(`TSTH_DUO_${uniq}`);

    const sub = await prisma.memberSubscription.findFirstOrThrow({ where: { ownerId } });
    expect(sub.pendingEffectiveAt!.toISOString()).toBe(sub.expiresAt.toISOString());

    // Seat 2 occupied → one member too many for SOLO, and they cannot be kept.
    await prisma.subscriptionSeat.update({
      where: { subscriptionId_seatNo: { subscriptionId: sub.id, seatNo: 2 } },
      data: { memberId: guestId, claimedAt: new Date() },
    });
    const me = await auth(request(app).get('/api/subscription/me'));
    expect(me.body.data.pendingChange.mustEvict).toBe(true);

    const seat2 = await prisma.subscriptionSeat.findFirstOrThrow({
      where: { subscriptionId: sub.id, seatNo: 2 },
    });
    const tooMany = await auth(
      request(app).post('/api/subscription/pending/seats').send({ seatIds: [seat2.id] }),
    );
    expect(tooMany.status).toBe(400); // SOLO has room for the owner only
    expect(tooMany.body.error.message).toContain('maksimal');

    // An empty choice is legal — it means "keep nobody but me".
    const none = await auth(
      request(app).post('/api/subscription/pending/seats').send({ seatIds: [] }),
    );
    expect(none.status).toBe(200);

    // A store-scheduled change is Apple's to revert, not ours.
    await prisma.memberSubscription.update({
      where: { id: sub.id },
      data: { pendingSource: 'revenuecat' },
    });
    const storeOwned = await auth(request(app).delete('/api/subscription/pending'));
    expect(storeOwned.status).toBe(400);
    expect(storeOwned.body.error.message).toContain('App Store');

    await prisma.memberSubscription.update({
      where: { id: sub.id },
      data: { pendingSource: 'web' },
    });
    const dropped = await auth(request(app).delete('/api/subscription/pending'));
    expect(dropped.status).toBe(200);
    expect(dropped.body.data.pendingChange).toBeNull();

    // Leave the fixture as the cancel test expects it.
    await prisma.subscriptionSeat.update({
      where: { subscriptionId_seatNo: { subscriptionId: sub.id, seatNo: 2 } },
      data: { memberId: null, claimedAt: null },
    });
  });

  it('GET /quote prices every plan and says whether checkout would take it now', async () => {
    const ownerToken = await login(ownerEmail);
    const q = (planCode: string) =>
      request(app)
        .get(`/api/subscription/quote?planCode=${planCode}`)
        .set('authorization', `Bearer ${ownerToken}`);

    // Owner sits on DUO (2 seats). SOLO is 1 seat at the same price, so it ranks
    // below on seat count — a downgrade.
    const down = await q(`TSTH_SOLO_${uniq}`);
    expect(down.status).toBe(200);
    expect(down.body.data).toMatchObject({
      action: 'downgrade',
      prorationCredit: 0, // a downgrade credits nothing
      payableNow: false,
      payableReason: 'not_scheduled', // must be declared first
    });
    expect(down.body.data.amount).toBe(down.body.data.price);
    expect(down.body.data.productId).toBeTruthy(); // ready to hand to checkout

    // Same plan = renewal, and paying early is allowed.
    const same = await q(`TSTH_DUO_${uniq}`);
    expect(same.body.data).toMatchObject({ action: 'renewal', payableNow: true });

    // Once scheduled, the reason moves on to "the term is still running".
    await request(app)
      .post('/api/subscription/pending')
      .set('authorization', `Bearer ${ownerToken}`)
      .send({ planCode: `TSTH_SOLO_${uniq}` });
    const scheduled = await q(`TSTH_SOLO_${uniq}`);
    expect(scheduled.body.data).toMatchObject({
      payableNow: false,
      payableReason: 'term_running',
    });
    expect(scheduled.body.data.effectiveAt).toBeTruthy();

    // The pending change now carries the product to buy at renewal, while
    // `renewal.productId` keeps naming the plan that is still running.
    const me = await request(app)
      .get('/api/subscription/me')
      .set('authorization', `Bearer ${ownerToken}`);
    expect(me.body.data.pendingChange.productId).toBe(scheduled.body.data.productId);
    expect(me.body.data.renewal.productId).not.toBe(scheduled.body.data.productId);

    await request(app)
      .delete('/api/subscription/pending')
      .set('authorization', `Bearer ${ownerToken}`);
  });

  it('a seat member is not shown the owner’s pending change or seat choices', async () => {
    const ownerToken = await login(ownerEmail);
    const sub = await prisma.memberSubscription.findFirstOrThrow({ where: { ownerId } });
    await prisma.subscriptionSeat.update({
      where: { subscriptionId_seatNo: { subscriptionId: sub.id, seatNo: 2 } },
      data: { memberId: guestId, claimedAt: new Date() },
    });
    // Declare FIRST: scheduling a change clears any previous selection, since a
    // new target is a new question.
    await request(app)
      .post('/api/subscription/pending')
      .set('authorization', `Bearer ${ownerToken}`)
      .send({ planCode: `TSTH_SOLO_${uniq}` });
    await prisma.subscriptionSeat.update({
      where: { subscriptionId_seatNo: { subscriptionId: sub.id, seatNo: 2 } },
      data: { pendingKeep: true },
    });

    const guestToken = await login(guestEmail);
    const guestMe = await request(app)
      .get('/api/subscription/me')
      .set('authorization', `Bearer ${guestToken}`);
    expect(guestMe.body.data.role).toBe('member');
    // Withheld: `false` would be indistinguishable from "the owner has not decided",
    // so showing it invites a wrong conclusion the member cannot act on anyway.
    expect(guestMe.body.data.pendingChange).toBeNull();
    expect(guestMe.body.data.seat.keepOnChange).toBeUndefined();
    expect(guestMe.body.data.seats).toBeUndefined(); // no household roster either

    // The owner still sees both.
    const ownerMe = await request(app)
      .get('/api/subscription/me')
      .set('authorization', `Bearer ${ownerToken}`);
    expect(ownerMe.body.data.pendingChange).not.toBeNull();
    expect(ownerMe.body.data.seats.find((s: { seatNo: number }) => s.seatNo === 2).keepOnChange).toBe(
      true,
    );

    await request(app)
      .delete('/api/subscription/pending')
      .set('authorization', `Bearer ${ownerToken}`);
    await prisma.subscriptionSeat.update({
      where: { subscriptionId_seatNo: { subscriptionId: sub.id, seatNo: 2 } },
      data: { memberId: null, claimedAt: null, pendingKeep: false },
    });
  });

  it('an upgrade is refused by the pending endpoint — it belongs to checkout', async () => {
    const guestToken = await login(guestEmail);
    // The guest owns nothing, so the same endpoint answers the no-subscription case.
    const r = await request(app)
      .post('/api/subscription/pending')
      .set('authorization', `Bearer ${guestToken}`)
      .send({ planCode: `TSTH_SOLO_${uniq}` });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('Tidak ada subscription aktif');

    const ownerToken = await login(ownerEmail);
    const up = await request(app)
      .post('/api/subscription/pending')
      .set('authorization', `Bearer ${ownerToken}`)
      .send({ planCode: `TSTH_DUO_${uniq}` }); // already on DUO → revert, not an upgrade
    expect(up.status).toBe(200);
    expect(up.body.data.pendingChange).toBeNull();
  });

  it('POST /cancel sets the intent (idempotent); RC-sourced subs get the store message', async () => {
    const ownerToken = await login(ownerEmail);
    const r = await request(app)
      .post('/api/subscription/cancel')
      .set('authorization', `Bearer ${ownerToken}`);
    expect(r.status).toBe(200);
    expect(r.body.data.canceled).toBe(true);

    const sub = await prisma.memberSubscription.findFirstOrThrow({ where: { ownerId } });
    expect(sub.canceledAt).not.toBeNull();
    expect(sub.status).toBe('ACTIVE'); // access continues
    expect(sub.graceUntil!.getTime()).toBe(sub.expiresAt.getTime()); // grace given up

    const again = await request(app)
      .post('/api/subscription/cancel')
      .set('authorization', `Bearer ${ownerToken}`);
    expect(again.status).toBe(200); // idempotent

    // RC-sourced sub → 400 with the store message
    await prisma.memberSubscription.update({
      where: { id: sub.id },
      data: { source: 'revenuecat' },
    });
    const rc = await request(app)
      .post('/api/subscription/cancel')
      .set('authorization', `Bearer ${ownerToken}`);
    expect(rc.status).toBe(400);
    expect(rc.body.error.message).toContain('App Store');
  });
});
