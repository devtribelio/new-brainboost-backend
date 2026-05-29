import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PaymentService } from '@/modules/commerce/payment.service';
import { prisma } from '@bb/db';
import type { XenditGateway } from '@bb/common/services/xendit-gateway';
import type { CreateInvoiceRequest, Invoice } from 'xendit-node/invoice/models';
import {
  createTestMember,
  createTestProduct,
  createPendingTransaction,
  cleanup,
} from './fixtures';

function makeMockGateway(overrides: Partial<XenditGateway> = {}): XenditGateway {
  return {
    createInvoice: async (_params: CreateInvoiceRequest): Promise<Invoice> =>
      ({
        id: `inv-${Math.random().toString(36).slice(2, 12)}`,
        externalId: _params.externalId,
        status: 'PENDING',
        userId: 'user-test',
        merchantName: 'BB',
        merchantProfilePictureUrl: '',
        amount: _params.amount,
        currency: 'IDR',
        expiryDate: new Date(),
        invoiceUrl: 'https://checkout-staging.xendit.co/web/0193abc',
        availableBanks: [],
        availableRetailOutlets: [],
        availableEwallets: [],
        availableQrCodes: [],
        availableDirectDebits: [],
        availablePaylaters: [],
        shouldExcludeCreditCard: false,
        shouldSendEmail: false,
        created: new Date(),
        updated: new Date(),
      }) as unknown as Invoice,
    expireInvoice: async () => ({}) as Invoice,
    ...overrides,
  };
}

describe('PaymentService — Invoice dispatch', () => {
  let memberId = '';
  let productId = '';

  beforeAll(async () => {
    const m = await createTestMember('pay-inv');
    memberId = m.id;
    const p = await createTestProduct('Invoice Test', 450_000);
    productId = p.id;
  });

  afterAll(async () => {
    await cleanup(memberId, productId);
    await prisma.$disconnect();
  });

  it('creates Xendit invoice and returns invoiceUrl', async () => {
    const tx = await createPendingTransaction(memberId, productId, 450_000);
    const svc = new PaymentService(makeMockGateway());

    const r = await svc.create(memberId, { transactionId: tx.id });

    expect(r.paymentStatus).toBe('PENDING');
    expect(r.transactionStatus).toBe('PENDING');
    expect(r.invoiceUrl).toBe('https://checkout-staging.xendit.co/web/0193abc');
    expect(r.amount).toBe(450_000);
    expect(r.fee).toBe(0);

    const payment = await prisma.commercePayment.findUnique({ where: { id: r.paymentId } });
    expect(payment?.paymentType).toBe('invoice');
    expect(payment?.status).toBe('PENDING');
    expect(payment?.checkoutUrl).toBe('https://checkout-staging.xendit.co/web/0193abc');
  });

  it('rejects when transaction not PENDING', async () => {
    const tx = await prisma.commerceTransaction.create({
      data: {
        code: `TEST-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        memberId,
        productId,
        qty: 1,
        itemTotal: 100_000,
        amount: 100_000,
        status: 'PAID',
      },
    });
    const svc = new PaymentService(makeMockGateway());
    await expect(svc.create(memberId, { transactionId: tx.id })).rejects.toThrow(/PAID/);
  });

  it('rejects when not owner', async () => {
    const other = await createTestMember('pay-inv-other');
    const tx = await createPendingTransaction(memberId, productId, 100_000);
    const svc = new PaymentService(makeMockGateway());
    await expect(svc.create(other.id, { transactionId: tx.id })).rejects.toThrow(/Not your transaction/);
    await prisma.refreshToken.deleteMany({ where: { memberId: other.id } });
    await prisma.member.delete({ where: { id: other.id } });
  });

  it('voucher 100% bypass when amount=0 (no Xendit call)', async () => {
    const tx = await createPendingTransaction(memberId, productId, 0);
    let xenditCalled = false;
    const svc = new PaymentService(
      makeMockGateway({
        createInvoice: async () => {
          xenditCalled = true;
          return {} as Invoice;
        },
      }),
    );

    const r = await svc.create(memberId, { transactionId: tx.id });

    expect(xenditCalled).toBe(false);
    expect(r.paymentStatus).toBe('SUCCESS');
    expect(r.transactionStatus).toBe('PAID');
    expect(r.invoiceUrl).toBeUndefined();
  });
});
