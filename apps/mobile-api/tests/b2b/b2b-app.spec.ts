import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { isB2bManagedMember, filterOutB2bManaged } from '@bb/domain/b2b/managed-member';
import { BannerService } from '../../src/modules/banner/banner.service';
import { buildApp } from '../../src/app';

const TAG = `b2bapp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const app = buildApp();
const password = 'secret123';
const ids = {
  x: '', y: '', z: '',
  custA: '', custB: '', planA: '', planB: '', planInactive: '', custC: '',
  k1: '', k2: '', k3: '', personal: '',
  productIds: [] as string[],
  bannerId: '',
};
let tokenX = '';

async function mkMember(suffix: string, signupSource: string | null) {
  const m = await prisma.member.create({
    data: {
      email: `${TAG}-${suffix}@test.local`,
      passwordHash: await bcrypt.hash(password, 4),
      isActive: true,
      isEmailVerified: true,
      signupSource,
    },
  });
  return m.id;
}
async function mkCourse(title: string, legacy: number) {
  const p = await prisma.product.create({
    data: { type: 'course', title: `${TAG} ${title}`, price: 250_000, iosPrice: 299_000, course: { create: { legacyCourseId: legacy, durationMin: 30 } } },
    include: { course: true },
  });
  ids.productIds.push(p.id);
  return p.course!.id;
}
const grant = (customerId: string, paymentPlanId: string, memberId: string, courseId: string, isActive = true) =>
  prisma.b2bMemberGrant.create({ data: { customerId, paymentPlanId, memberId, courseId, isActive } });
const get = (path: string, token = tokenX) => request(app).get(`/api/b2b-app${path}`).set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  const base = Math.floor(Math.random() * 1e8) + 9e8;
  ids.x = await mkMember('x', 'b2b');
  ids.y = await mkMember('y', 'b2b');
  ids.z = await mkMember('z', null);
  ids.custA = (await prisma.b2bCustomer.create({ data: { companyName: `${TAG} Alpha` } })).id;
  ids.custB = (await prisma.b2bCustomer.create({ data: { companyName: `${TAG} Beta` } })).id;
  ids.custC = (await prisma.b2bCustomer.create({ data: { companyName: `${TAG} Gamma` } })).id;
  ids.planA = (await prisma.b2bPaymentPlan.create({ data: { customerId: ids.custA, name: 'A', package: 'subscription' } })).id;
  ids.planB = (await prisma.b2bPaymentPlan.create({ data: { customerId: ids.custB, name: 'B', package: 'subscription' } })).id;
  ids.planInactive = (await prisma.b2bPaymentPlan.create({ data: { customerId: ids.custC, name: 'C', package: 'subscription', isActive: false } })).id;
  ids.k1 = await mkCourse('Beta course', base + 1);
  ids.k2 = await mkCourse('Zeta course', base + 2);
  ids.k3 = await mkCourse('Alpha course', base + 3);
  ids.personal = await mkCourse('Personal only', base + 4);

  // X: seat at A for k1, k2, k3. k3 was ALSO bought personally (unmarked, permanent).
  for (const c of [ids.k1, ids.k2, ids.k3]) await grant(ids.custA, ids.planA, ids.x, c);
  // X: a seat on an inactive plan of company C must not show C.
  await grant(ids.custC, ids.planInactive, ids.x, ids.k1);
  await prisma.courseEnrollment.createMany({
    data: [
      { memberId: ids.x, courseId: ids.k1, viaB2bGrantId: null, expiredDate: new Date(Date.now() + 86_400_000), progress: 0.5 },
      { memberId: ids.x, courseId: ids.k3 },
      { memberId: ids.x, courseId: ids.personal },
    ],
  });
  // Y: seat at B only. Z: not B2B-born, but has a seat at A.
  await grant(ids.custB, ids.planB, ids.y, ids.k1);
  await grant(ids.custA, ids.planA, ids.z, ids.k2);

  await prisma.b2bCompanyBranding.create({
    data: {
      customerId: ids.custA,
      displayName: 'Alpha Academy',
      primaryColor: '#0F766E',
      welcomeText: 'Halo tim Alpha',
      courseLayout: [{ title: 'Wajib', course_ids: [ids.k2] }],
      announcements: [
        { id: 'now', title: 'Live', body: 'x', starts_at: '2020-01-01', ends_at: '2999-01-01' },
        { id: 'past', title: 'Old', body: 'x', starts_at: '2020-01-01', ends_at: '2020-02-01' },
        { id: 'open', title: 'Open', body: 'x' },
      ],
    },
  });
  ids.bannerId = (await prisma.banner.create({ data: { title: TAG, imageUrl: `https://img/${TAG}.png`, isActive: true } })).id;

  const res = await request(app)
    .post('/api/member/oauth/token')
    .send({ grant_type: 'password', username: `${TAG}-x@test.local`, password, client_type: 'b2b' });
  tokenX = res.body.data.access_token;
});

afterAll(async () => {
  const members = [ids.x, ids.y, ids.z];
  await prisma.banner.deleteMany({ where: { id: ids.bannerId } });
  await prisma.b2bMemberGrant.deleteMany({ where: { memberId: { in: members } } });
  await prisma.b2bCompanyBranding.deleteMany({ where: { customerId: { in: [ids.custA, ids.custB, ids.custC] } } });
  await prisma.b2bPaymentPlan.deleteMany({ where: { id: { in: [ids.planA, ids.planB, ids.planInactive] } } });
  await prisma.b2bCustomer.deleteMany({ where: { id: { in: [ids.custA, ids.custB, ids.custC] } } });
  await prisma.courseEnrollment.deleteMany({ where: { memberId: { in: members } } });
  await prisma.refreshToken.deleteMany({ where: { memberId: { in: members } } });
  await prisma.product.deleteMany({ where: { id: { in: ids.productIds } } });
  await prisma.member.deleteMany({ where: { id: { in: members } } });
  await prisma.$disconnect();
});

describe('GET /api/b2b-app/companies', () => {
  it('lists only companies with an active seat (grant AND plan active)', async () => {
    const res = await get('/companies');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { company_id: ids.custA, display_name: 'Alpha Academy', logo_url: null, primary_color: '#0F766E', course_count: 3 },
    ]);
  });
});

describe('GET /api/b2b-app/companies/:companyId', () => {
  it('returns the theme with only announcements active now', async () => {
    const res = await get(`/companies/${ids.custA}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ display_name: 'Alpha Academy', welcome_text: 'Halo tim Alpha' });
    expect(res.body.data.announcements.map((a: { id: string }) => a.id)).toEqual(['now', 'open']);
  });

  it('404 for a company the member has no seat at, an inactive plan, an unknown or malformed id', async () => {
    for (const id of [ids.custB, ids.custC, '00000000-0000-0000-0000-000000000000', 'not-a-uuid']) {
      expect((await get(`/companies/${id}`)).status).toBe(404);
      expect((await get(`/companies/${id}/courses`)).status).toBe(404);
    }
  });
});

describe('GET /api/b2b-app/companies/:companyId/courses', () => {
  it('lists granted courses by the company layout, never personal-only ones, never prices', async () => {
    const res = await get(`/companies/${ids.custA}/courses`);
    expect(res.status).toBe(200);
    const groups = res.body.data.groups as Array<{ title: string; courses: Array<Record<string, unknown>> }>;
    expect(groups.map((g) => [g.title, g.courses.map((c) => c.course_uuid)])).toEqual([
      ['Wajib', [ids.k2]],
      ['Kursus', [ids.k3, ids.k1]], // trailing group sorted by title: "Alpha course", "Beta course"
    ]);
    const all = groups.flatMap((g) => g.courses);
    expect(all.find((c) => c.course_uuid === ids.personal)).toBeUndefined();
    // Personal purchase that is ALSO granted: listed, with access from the enrollment.
    expect(all.find((c) => c.course_uuid === ids.k3)).toMatchObject({ access: { active: true, expires_at: null } });
    expect(all.find((c) => c.course_uuid === ids.k1)).toMatchObject({ access: { active: true }, progress: 0.5 });
    expect(all.find((c) => c.course_uuid === ids.k2)).toMatchObject({ access: { active: false, expires_at: null } });
    expect(JSON.stringify(res.body)).not.toMatch(/price/i);
  });
});

describe('B2B-managed members and marketing', () => {
  it('b2b-born with an active seat → managed; not b2b-born → not; last seat revoked → not', async () => {
    expect(await isB2bManagedMember(ids.x)).toBe(true);
    expect(await isB2bManagedMember(ids.z)).toBe(false);
    expect(await filterOutB2bManaged([ids.x, ids.z, ids.y])).toEqual([ids.z]);

    await prisma.b2bMemberGrant.updateMany({ where: { memberId: ids.y }, data: { isActive: false } });
    expect(await isB2bManagedMember(ids.y)).toBe(false);
  });

  it('promo banners are hidden for a managed member, shown for others and anonymous', async () => {
    const svc = new BannerService();
    const p = { page: 1, perPage: 50, skip: 0, take: 50 };
    const forX = await svc.listActive(p, undefined, { memberId: ids.x });
    const forZ = await svc.listActive(p, undefined, { memberId: ids.z });
    const anon = await svc.listActive(p);
    expect(forX.rows).toHaveLength(0);
    expect(forZ.rows.some((b) => b.id === ids.bannerId)).toBe(true);
    expect(anon.rows.some((b) => b.id === ids.bannerId)).toBe(true);
  });
});

describe('community push for B2B-managed members', () => {
  it('writes the feed row but skips the push (and spends no push budget)', async () => {
    const { NotificationProducer } = await import('@bb/domain/notification/notification.producer');
    const { ActionLabel } = await import('@bb/domain/notification/action-labels');
    const { fcmService } = await import('@bb/domain/notification/fcm.service');
    await prisma.b2bMemberGrant.updateMany({ where: { memberId: ids.x }, data: { isActive: true } });
    const svc = fcmService as unknown as { enabled: boolean };
    const saved = svc.enabled;
    svc.enabled = true; // reach the dispatch path without sending anything real
    const spy = vi.spyOn(fcmService, 'sendToMember').mockResolvedValue();
    try {
      await prisma.member.updateMany({ where: { id: { in: [ids.x, ids.z] } }, data: { unopenedPushCount: 0 } });
      const producer = new NotificationProducer();
      const rowX = await producer.createForMember({ memberId: ids.x, type: ActionLabel.NewPost, title: 'post', dedupeKey: `${TAG}-x` });
      const rowZ = await producer.createForMember({ memberId: ids.z, type: ActionLabel.NewPost, title: 'post', dedupeKey: `${TAG}-z` });
      await new Promise((r) => setTimeout(r, 300));
      expect(rowX).not.toBeNull();
      expect(rowZ).not.toBeNull();
      const pushedTo = spy.mock.calls.map((c) => c[0]);
      expect(pushedTo).toContain(ids.z);
      expect(pushedTo).not.toContain(ids.x);
      const x = await prisma.member.findUnique({ where: { id: ids.x }, select: { unopenedPushCount: true } });
      expect(x!.unopenedPushCount).toBe(0);
    } finally {
      spy.mockRestore();
      svc.enabled = saved;
      await prisma.notification.deleteMany({ where: { dedupeKey: { in: [`${TAG}-x`, `${TAG}-z`] } } });
    }
  });
});
