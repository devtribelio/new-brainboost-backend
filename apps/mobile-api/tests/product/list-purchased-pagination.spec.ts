import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@bb/db';
import { ProductService } from '@/modules/product/product.service';
import { createTestMember, createTestProduct } from '../commerce/fixtures';

const svc = new ProductService();

// Regression: a member with 11 enrollments sharing ONE byte-identical `created_at`
// paged through `ownership=purchased` and got a page-1 row repeated on page 2 while
// another enrollment vanished entirely. Cause: `ORDER BY created_at DESC` over an
// all-ties set has no defined order, so two executions may return two different
// permutations and OFFSET slices different sets. Reproduced by writing the same
// timestamp to every row — exactly what chunked `createMany` does in the legacy
// migration, where `now()` is constant within a statement.
const KW = `ppkw${Date.now().toString(36)}`;
const TOTAL = 11;
const PER_PAGE = 10;
const SAME_CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

let memberId: string;
const productIds: string[] = [];
const courseIds: string[] = [];

describe('ProductService.list ownership=purchased pagination', () => {
  beforeAll(async () => {
    const m = await createTestMember('purchased-pagination');
    memberId = m.id;

    for (let i = 0; i < TOTAL; i++) {
      const p = await createTestProduct(`${KW} Course ${i}`, 10_000 + i);
      productIds.push(p.id);
      const c = await prisma.course.create({ data: { productId: p.id } });
      courseIds.push(c.id);
      await prisma.courseEnrollment.create({ data: { memberId, courseId: c.id } });
    }

    // Collapse every enrollment onto one timestamp so `createdAt` carries no
    // ordering information at all.
    await prisma.courseEnrollment.updateMany({
      where: { memberId },
      data: { createdAt: SAME_CREATED_AT },
    });
  });

  afterAll(async () => {
    await prisma.courseEnrollment.deleteMany({ where: { memberId } });
    await prisma.course.deleteMany({ where: { id: { in: courseIds } } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  });

  const pageParams = (page: number) => ({
    page,
    perPage: PER_PAGE,
    skip: (page - 1) * PER_PAGE,
    take: PER_PAGE,
  });

  async function idsOnPage(page: number) {
    const r = await svc.list(pageParams(page), {
      ownership: 'purchased',
      memberId,
      keyword: KW,
    });
    return { ids: r.rows.map((x) => x.id), total: r.total };
  }

  it('pages 1+2 cover all 11 enrollments with no overlap and none missing', async () => {
    const p1 = await idsOnPage(1);
    const p2 = await idsOnPage(2);

    expect(p1.total).toBe(TOTAL);
    expect(p1.ids).toHaveLength(PER_PAGE);
    expect(p2.ids).toHaveLength(TOTAL - PER_PAGE);

    const overlap = p1.ids.filter((id) => p2.ids.includes(id));
    expect(overlap).toEqual([]);

    const seen = new Set([...p1.ids, ...p2.ids]);
    expect(seen.size).toBe(TOTAL);
    expect([...seen].sort()).toEqual([...productIds].sort());
  });

  // The production trigger. Ties are sorted by whatever order the scan feeds in,
  // which is heap order — and an UPDATE writes a new tuple version at the end of
  // the heap, so touching one row (a progress save mid-session) silently moves it
  // to the back of the tie group between two page fetches. Under `createdAt DESC`
  // that row jumps from page 1 to page 2 and shoves another row the other way, so
  // page 2 shows a row the client already has and never shows the one it displaced.
  it('a row updated between page 1 and page 2 does not reshuffle the pages', async () => {
    const p1 = await idsOnPage(1);

    const touched = await prisma.courseEnrollment.findFirst({
      where: { memberId, course: { productId: p1.ids[0] } },
      select: { id: true },
    });
    await prisma.courseEnrollment.update({
      where: { id: touched!.id },
      data: { progress: 0.5 },
    });

    const p1After = await idsOnPage(1);
    const p2 = await idsOnPage(2);

    expect(p1After.ids).toEqual(p1.ids);
    expect(p1After.ids.filter((id) => p2.ids.includes(id))).toEqual([]);
    expect(new Set([...p1After.ids, ...p2.ids]).size).toBe(TOTAL);
  });
});
