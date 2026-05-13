import { prisma } from '@/config/prisma';
import * as bcrypt from 'bcryptjs';

export async function createTestMember(seed: string) {
  const ts = Date.now();
  const email = `${seed}-${ts}@test.local`;
  return prisma.member.create({
    data: {
      email,
      passwordHash: await bcrypt.hash('secret', 4),
      fullName: `${seed} Tester`,
    },
  });
}

export async function createTestProduct(title: string, price: number) {
  return prisma.product.create({
    data: { type: 'course', title, price, isActive: true, status: 'active' },
  });
}

export async function createPendingTransaction(memberId: string, productId: string, amount: number) {
  const ts = Date.now();
  return prisma.commerceTransaction.create({
    data: {
      code: `TEST-${ts}-${Math.floor(Math.random() * 1000)}`,
      memberId,
      productId,
      qty: 1,
      itemTotal: amount,
      amount,
      status: 'PENDING',
      expiredAt: new Date(Date.now() + 3600 * 1000),
    },
  });
}

export async function cleanup(memberId: string, productId: string) {
  await prisma.commercePaymentEvent.deleteMany({
    where: { payment: { memberId } },
  });
  await prisma.commercePayment.deleteMany({ where: { memberId } });
  await prisma.commerceTransaction.deleteMany({ where: { memberId } });
  await prisma.refreshToken.deleteMany({ where: { memberId } });
  await prisma.member.delete({ where: { id: memberId } });
  await prisma.product.delete({ where: { id: productId } });
}
