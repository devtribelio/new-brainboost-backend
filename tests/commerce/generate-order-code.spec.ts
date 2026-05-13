import { describe, it, expect, afterAll } from 'vitest';
import { generateOrderCode } from '@/modules/commerce/utils/generate-order-code';
import { prisma } from '@/config/prisma';

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
});
