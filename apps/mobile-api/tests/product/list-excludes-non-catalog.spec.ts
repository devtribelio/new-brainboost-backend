import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@bb/db';
import { ProductService } from '@/modules/product/product.service';

// `products` is not a catalog table: an event ticket is one product row per
// ticket kind, so a single webinar would otherwise put three entries in the
// mobile catalog — each opening a course detail page with no course behind it.
const svc = new ProductService();
const token = Date.now().toString(36);
const created: string[] = [];

async function makeProduct(type: string, title: string) {
  const p = await prisma.product.create({
    data: { type, title, price: 150_000, isActive: true, status: 'active' },
  });
  created.push(p.id);
  return p;
}

let courseId = '';
let ticketId = '';

beforeAll(async () => {
  const course = await makeProduct('course', `Catalog course ${token}`);
  courseId = course.id;
  await prisma.course.create({ data: { productId: courseId } });
  ticketId = (await makeProduct('event_ticket', `Ticket kind ${token}`)).id;
});

afterAll(async () => {
  await prisma.course.deleteMany({ where: { productId: { in: created } } });
  await prisma.product.deleteMany({ where: { id: { in: created } } });
});

describe('ProductService.list hides non-catalog product types', () => {
  it('omits an event_ticket product from the default list', async () => {
    const { rows } = await svc.list({ skip: 0, take: 100, page: 1, perPage: 100 }, {
      keyword: token,
    });
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(courseId);
    expect(ids).not.toContain(ticketId);
  });

  it('omits it on the raw-SQL path too (sort=top_rated)', async () => {
    // Both paths serve the same endpoint, so a rule applied to only one of them
    // would show different products depending on how the list is sorted.
    const { rows } = await svc.list({ skip: 0, take: 100, page: 1, perPage: 100 }, {
      keyword: token,
      sort: 'top_rated',
    });
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(courseId);
    expect(ids).not.toContain(ticketId);
  });

  it('still counts only listable products in the total', async () => {
    const { total } = await svc.list({ skip: 0, take: 100, page: 1, perPage: 100 }, {
      keyword: token,
    });
    expect(total).toBe(1);
  });
});
