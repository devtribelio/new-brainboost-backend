/**
 * BE-10 + BE-11 — subscription-aware content surface:
 * media gate delegates to EntitlementService (subscriber streams, stranger
 * 403, lazy row created); product list/badges: subscriber owns every
 * course-backed product, lapsed sub reverts, retail legacy rows (past
 * expired_date, no marker) stay owned, plan products hidden from the default
 * catalog. Service-level over real Postgres (same pattern as tests/product/).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@bb/db';
import { ProductService } from '@/modules/product/product.service';
import { MediaService } from '@/modules/media/media.service';
import { SubscriptionService } from '@bb/domain/subscription/subscription.service';
import { ForbiddenException } from '@bb/common/exceptions';

const productService = new ProductService();
const mediaService = new MediaService();
const subscriptionService = new SubscriptionService();

const uniq = randomUUID().slice(0, 8);
const KW = `SubProdKW${uniq}`;
const PAGE = { page: 1, perPage: 50, skip: 0, take: 50 };
const DAY_MS = 24 * 3600 * 1000;

let subscriberId: string;
let lapsedId: string;
let retailId: string;
let strangerId: string;
let planProductId: string;
let courseAProductId: string;
let courseBProductId: string;
let courseAId: string;

async function makeMember(tag: string): Promise<string> {
  const m = await prisma.member.create({
    data: { email: `psub-${tag}-${uniq}@test.local`, passwordHash: 'x', isActive: true },
  });
  return m.id;
}

async function makeCourseProduct(tag: string): Promise<{ productId: string; courseId: string }> {
  const p = await prisma.product.create({
    data: {
      type: 'course',
      code: `TSTP-${tag}-${uniq}`,
      title: `${KW} course ${tag}`,
      price: 100_000,
      isActive: true,
      status: 'active',
    },
  });
  const c = await prisma.course.create({ data: { productId: p.id } });
  return { productId: p.id, courseId: c.id };
}

async function activateSub(ownerId: string) {
  const res = await subscriptionService.activateFromPayment({
    ownerId,
    productId: planProductId,
    transactionId: randomUUID(),
    source: 'xendit',
  });
  return res.subscription!;
}

async function cleanup() {
  await prisma.courseEnrollment.deleteMany({ where: { member: { email: { contains: uniq } } } });
  const subs = await prisma.memberSubscription.findMany({
    where: { plan: { code: { contains: uniq } } },
    select: { id: true },
  });
  await prisma.courseEnrollment.deleteMany({
    where: { viaSubscriptionId: { in: subs.map((s) => s.id) } },
  });
  await prisma.memberSubscription.deleteMany({ where: { id: { in: subs.map((s) => s.id) } } });
  await prisma.subscriptionPlan.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.product.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.member.deleteMany({ where: { email: { contains: uniq } } });
}

beforeAll(async () => {
  await cleanup();
  subscriberId = await makeMember('subscriber');
  lapsedId = await makeMember('lapsed');
  retailId = await makeMember('retail');
  strangerId = await makeMember('stranger');

  const planProduct = await prisma.product.create({
    data: {
      type: 'subscription',
      code: `TSTP-PLAN-${uniq}`,
      title: `${KW} plan solo`,
      price: 999_000,
      isActive: true,
      status: 'active',
    },
  });
  planProductId = planProduct.id;
  await prisma.subscriptionPlan.create({
    data: {
      productId: planProductId,
      code: `TSTP_SOLO_${uniq}`,
      tier: 'SOLO',
      periodMonths: 12,
      seatCount: 1,
      affiliateRate: 40,
      renewalAffiliateRate: 20,
      sortOrder: 99,
    },
  });

  ({ productId: courseAProductId, courseId: courseAId } = await makeCourseProduct('A'));
  ({ productId: courseBProductId } = await makeCourseProduct('B'));

  // subscriber: active sub, never opened any course
  await activateSub(subscriberId);

  // lapsed: sub past grace + a dead lazy row on course A
  const lapsedSub = await activateSub(lapsedId);
  await prisma.courseEnrollment.create({
    data: {
      memberId: lapsedId,
      courseId: courseAId,
      viaSubscriptionId: lapsedSub.id,
      expiredDate: new Date(Date.now() - 10 * DAY_MS),
    },
  });
  await prisma.memberSubscription.update({
    where: { id: lapsedSub.id },
    data: {
      status: 'EXPIRED',
      expiresAt: new Date(Date.now() - 10 * DAY_MS),
      graceUntil: new Date(Date.now() - 3 * DAY_MS),
    },
  });

  // retail: legacy-style enrollment on course A — expired_date in the PAST, no marker
  await prisma.courseEnrollment.create({
    data: { memberId: retailId, courseId: courseAId, expiredDate: new Date('2020-01-01') },
  });
});

afterAll(cleanup);

describe('product list & badges (BE-11)', () => {
  it('default list hides subscription products; explicit ?type=subscription shows them', async () => {
    const def = await productService.list(PAGE, { keyword: KW });
    expect(def.rows.some((r) => r.id === planProductId)).toBe(false);
    expect(def.rows.some((r) => r.id === courseAProductId)).toBe(true);

    const explicit = await productService.list(PAGE, { keyword: KW, type: 'subscription' });
    expect(explicit.rows.map((r) => r.id)).toEqual([planProductId]);
  });

  it('raw-SQL path (top_rated) also hides subscription products', async () => {
    const res = await productService.list(PAGE, { keyword: KW, sort: 'top_rated' });
    expect(res.rows.some((r) => r.id === planProductId)).toBe(false);
    expect(res.rows.some((r) => r.id === courseAProductId)).toBe(true);
  });

  it('subscriber: every course-backed row badges as purchased', async () => {
    const res = await productService.list(PAGE, { keyword: KW, memberId: subscriberId });
    expect(res.purchasedProductIds.has(courseAProductId)).toBe(true);
    expect(res.purchasedProductIds.has(courseBProductId)).toBe(true);
  });

  it('subscriber: purchased tab lists ALL course products, even never-opened ones', async () => {
    const res = await productService.list(PAGE, {
      keyword: KW,
      memberId: subscriberId,
      ownership: 'purchased',
    });
    const ids = res.rows.map((r) => r.id);
    expect(ids).toContain(courseAProductId);
    expect(ids).toContain(courseBProductId);
    expect(ids).not.toContain(planProductId); // plan product is not a course
  });

  it('subscriber: not_purchased contains no course-backed products (typed + raw paths)', async () => {
    const typed = await productService.list(PAGE, {
      keyword: KW,
      memberId: subscriberId,
      ownership: 'not_purchased',
    });
    expect(typed.rows.some((r) => r.id === courseAProductId)).toBe(false);

    const raw = await productService.list(PAGE, {
      keyword: KW,
      memberId: subscriberId,
      ownership: 'not_purchased',
      sort: 'top_rated',
    });
    expect(raw.rows.some((r) => r.id === courseAProductId)).toBe(false);
  });

  it('lapsed sub reverts to non-subscriber: dead lazy row is not owned, courses buyable again', async () => {
    const list = await productService.list(PAGE, { keyword: KW, memberId: lapsedId });
    expect(list.purchasedProductIds.size).toBe(0);

    const purchased = await productService.list(PAGE, {
      keyword: KW,
      memberId: lapsedId,
      ownership: 'purchased',
    });
    expect(purchased.rows).toHaveLength(0);

    const notPurchased = await productService.list(PAGE, {
      keyword: KW,
      memberId: lapsedId,
      ownership: 'not_purchased',
    });
    expect(notPurchased.rows.some((r) => r.id === courseAProductId)).toBe(true);
  });

  it('retail legacy row (past expired_date, no marker) still counts as owned', async () => {
    const list = await productService.list(PAGE, { keyword: KW, memberId: retailId });
    expect(list.purchasedProductIds.has(courseAProductId)).toBe(true);

    const purchased = await productService.list(PAGE, {
      keyword: KW,
      memberId: retailId,
      ownership: 'purchased',
    });
    expect(purchased.rows.map((r) => r.id)).toEqual([courseAProductId]);

    const notPurchased = await productService.list(PAGE, {
      keyword: KW,
      memberId: retailId,
      ownership: 'not_purchased',
    });
    expect(notPurchased.rows.some((r) => r.id === courseAProductId)).toBe(false);
    expect(notPurchased.rows.some((r) => r.id === courseBProductId)).toBe(true);
  });
});

describe('media gate (BE-10)', () => {
  it('subscriber streams a never-opened course and gets a lazy enrollment row', async () => {
    await expect(mediaService.assertEnrollment(courseAId, subscriberId)).resolves.toBeUndefined();
    const row = await prisma.courseEnrollment.findUnique({
      where: { memberId_courseId: { memberId: subscriberId, courseId: courseAId } },
    });
    expect(row?.viaSubscriptionId).not.toBeNull();
  });

  it('stranger (no enrollment, no sub) → 403; lapsed lazy row → 403; retail legacy row → OK', async () => {
    await expect(mediaService.assertEnrollment(courseAId, strangerId)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(mediaService.assertEnrollment(courseAId, lapsedId)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(mediaService.assertEnrollment(courseAId, retailId)).resolves.toBeUndefined();
  });
});

describe('viaSubscription flag (list + detail sources)', () => {
  it('subscriber: purchased everywhere, viaSubscription=true on courses they don’t retail-own', async () => {
    const res = await productService.list(PAGE, { keyword: KW, memberId: subscriberId });
    expect(res.purchasedProductIds.has(courseAProductId)).toBe(true);
    expect(res.viaSubscriptionIds.has(courseAProductId)).toBe(true);
    expect(res.viaSubscriptionIds.has(courseBProductId)).toBe(true);
  });

  it('retail owner: purchased=true but viaSubscription=false (lifetime beats borrowed access)', async () => {
    const res = await productService.list(PAGE, { keyword: KW, memberId: retailId });
    expect(res.purchasedProductIds.has(courseAProductId)).toBe(true);
    expect(res.viaSubscriptionIds.has(courseAProductId)).toBe(false);
  });

  it('hybrid (active sub + retail-owned course): retail course false, the rest true — list and purchased tab agree', async () => {
    const hybridId = await makeMember('hybrid');
    await subscriptionService.activateFromPayment({
      ownerId: hybridId,
      productId: planProductId,
      transactionId: randomUUID(),
      source: 'xendit',
    });
    await prisma.courseEnrollment.create({
      data: { memberId: hybridId, courseId: courseAId }, // retail row (no marker)
    });

    const list = await productService.list(PAGE, { keyword: KW, memberId: hybridId });
    expect(list.purchasedProductIds.has(courseAProductId)).toBe(true);
    expect(list.viaSubscriptionIds.has(courseAProductId)).toBe(false); // retail wins
    expect(list.viaSubscriptionIds.has(courseBProductId)).toBe(true);

    const purchased = await productService.list(PAGE, {
      keyword: KW,
      memberId: hybridId,
      ownership: 'purchased',
    });
    expect(purchased.viaSubscriptionIds.has(courseAProductId)).toBe(false);
    expect(purchased.viaSubscriptionIds.has(courseBProductId)).toBe(true);
  });

  it('lapsed sub / anonymous: viaSubscription empty', async () => {
    const lapsed = await productService.list(PAGE, { keyword: KW, memberId: lapsedId });
    expect(lapsed.viaSubscriptionIds.size).toBe(0);
    const anon = await productService.list(PAGE, { keyword: KW });
    expect(anon.viaSubscriptionIds.size).toBe(0);
  });
});
