import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@bb/db';
import { ProductService } from '@/modules/product/product.service';

// Regression: affiliate OneLinks/deeplinks carry the product *slug* (from
// `/p/<slug>`) in the `product` param, not the short `code`. courseDetail must
// resolve either so those links open the product instead of 404-ing.
const svc = new ProductService();

describe('ProductService.courseDetail resolves by code or slug', () => {
  let productId: string;
  let courseId: string;
  const token = Date.now().toString(36);
  const code = `CD${token}`.slice(0, 8);
  const slug = `course-detail-slug-${token}`;

  beforeAll(async () => {
    const p = await prisma.product.create({
      data: {
        type: 'course',
        title: `Slug Detail ${token}`,
        price: 100_000,
        isActive: true,
        status: 'active',
        code,
        slug,
      },
    });
    productId = p.id;
    const c = await prisma.course.create({ data: { productId } });
    courseId = c.id;
  });

  afterAll(async () => {
    await prisma.course.deleteMany({ where: { id: courseId } });
    await prisma.product.deleteMany({ where: { id: productId } });
  });

  it('resolves by code', async () => {
    const { product } = await svc.courseDetail(code);
    expect(product.id).toBe(productId);
  });

  it('resolves by slug (deeplink / OneLink product param)', async () => {
    const { product } = await svc.courseDetail(slug);
    expect(product.id).toBe(productId);
  });

  it('throws NotFound for an unknown identifier', async () => {
    await expect(svc.courseDetail(`unknown-${token}`)).rejects.toThrow();
  });
});
