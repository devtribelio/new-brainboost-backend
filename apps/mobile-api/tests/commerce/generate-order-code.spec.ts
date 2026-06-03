import { describe, it, expect, afterAll } from 'vitest';
import { generateOrderCode } from '@bb/domain/commerce/utils/generate-order-code';
import { prisma } from '@bb/db';

describe('generateOrderCode', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('format BB-YYYYMMDD-####', async () => {
    const code = await generateOrderCode();
    expect(code).toMatch(/^BB-\d{8}-\d{4}$/);
  });

  it('today component matches now UTC date', async () => {
    const code = await generateOrderCode();
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    expect(code).toContain(`-${today}-`);
  });

  it('jitter appends a random hex suffix (collision-retry path)', async () => {
    const code = await generateOrderCode(new Date(), { jitter: true });
    expect(code).toMatch(/^BB-\d{8}-\d{4}-[0-9A-F]{4}$/);
  });
});
