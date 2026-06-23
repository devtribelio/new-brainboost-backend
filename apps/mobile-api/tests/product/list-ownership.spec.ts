import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@bb/db';
import { ProductService } from '@/modules/product/product.service';
import { createTestMember, createTestProduct } from '../commerce/fixtures';

const svc = new ProductService();

let memberId: string;
const productIds: string[] = [];
const courseIds: string[] = [];

async function makeCourse(productId: string) {
  const c = await prisma.course.create({ data: { productId } });
  courseIds.push(c.id);
  return c;
}

// Unique token shared by this suite's product titles. Every `list` call below
// passes it as `keyword` so the assertions are scoped to THESE products only —
// the suite runs in parallel against a shared DB, so a global (unscoped) query
// would also count products created by other concurrent suites.
const KW = `ownkw${Date.now().toString(36)}`;

describe('ProductService.list ownership filter', () => {
  let ownedCourseProductId: string;
  let notOwnedCourseProductId: string;
  let bookProductId: string;

  beforeAll(async () => {
    const m = await createTestMember('ownership');
    memberId = m.id;

    const owned = await createTestProduct(`${KW} Owned Course`, 100_000);
    const notOwned = await createTestProduct(`${KW} Other Course`, 200_000);
    const book = await prisma.product.create({
      data: { type: 'book', title: `${KW} Some Book`, price: 50_000, isActive: true, status: 'active' },
    });
    productIds.push(owned.id, notOwned.id, book.id);
    ownedCourseProductId = owned.id;
    notOwnedCourseProductId = notOwned.id;
    bookProductId = book.id;

    const ownedCourse = await makeCourse(owned.id);
    await makeCourse(notOwned.id);

    await prisma.courseEnrollment.create({
      data: { memberId, courseId: ownedCourse.id },
    });
  });

  afterAll(async () => {
    await prisma.courseEnrollment.deleteMany({ where: { memberId } });
    await prisma.course.deleteMany({ where: { id: { in: courseIds } } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  });

  const page = { page: 1, perPage: 50, skip: 0, take: 50 };

  it('ownership=purchased → only owned course (book excluded)', async () => {
    const r = await svc.list(page, { memberId, ownership: 'purchased', keyword: KW });
    expect(r.total).toBe(1);
    expect(r.rows[0].id).toBe(ownedCourseProductId);
    expect(r.purchasedProductIds.has(ownedCourseProductId)).toBe(true);
  });

  it('ownership=not_purchased → non-owned course + book', async () => {
    const r = await svc.list(page, { memberId, ownership: 'not_purchased', keyword: KW });
    const ids = r.rows.map((p) => p.id).sort();
    const expected = [notOwnedCourseProductId, bookProductId].sort();
    expect(ids).toEqual(expected);
    expect(r.total).toBe(2);
  });

  it('no ownership param → all 3 (legacy behavior preserved)', async () => {
    const r = await svc.list(page, { memberId, keyword: KW });
    const ourIds = r.rows.map((p) => p.id).filter((id) => productIds.includes(id));
    expect(ourIds.sort()).toEqual([...productIds].sort());
  });

  it('guest with ownership=purchased ignored (no memberId)', async () => {
    const r = await svc.list(page, { ownership: 'purchased', keyword: KW });
    // Guest path goes through the normal where; ignored ownership.
    const ourIds = r.rows.map((p) => p.id).filter((id) => productIds.includes(id));
    expect(ourIds.length).toBe(3);
  });
});
