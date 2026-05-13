import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PaymentService } from '@/modules/commerce/payment.service';
import { prisma } from '@/config/prisma';
import type {
  IXenditService,
  XenditVaOptions,
  XenditVaResult,
} from '@/common/services/xendit.service';
import { createTestMember, createTestProduct, createPendingTransaction, cleanup } from './fixtures';

function uid(): string {
  return `xnd-${Math.random().toString(36).slice(2, 12)}`;
}

class MockXendit implements IXenditService {
  vaArgs: XenditVaOptions | null = null;
  cancelCalls: string[] = [];
  vaReturn: XenditVaResult = {
    id: uid(),
    accountNumber: `8888${Math.floor(Math.random() * 1e12)}`,
    expirationDate: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    raw: {},
  };
  cancelError: { errorCode?: string } | null = null;
  generateExternalId(p = 'commerce'): string {
    return `${p}-${Math.random()}`;
  }
  verifyCallbackToken(): boolean {
    return true;
  }
  async createCardCharge(): Promise<never> {
    throw new Error('not called');
  }
  async createCallbackVa(opts: XenditVaOptions) {
    this.vaArgs = opts;
    return this.vaReturn;
  }
  async cancelVa(vaId: string) {
    this.cancelCalls.push(vaId);
    if (this.cancelError) {
      const e = new Error('cancel failed') as Error & { errorCode?: string };
      e.errorCode = this.cancelError.errorCode;
      throw e;
    }
    return { id: vaId, status: 'INACTIVE' };
  }
  async getVa() {
    return { status: 'INACTIVE', raw: {} };
  }
  async createEwalletCharge(): Promise<never> {
    throw new Error('not called');
  }
}

describe('PaymentService — VA dispatch', () => {
  let memberId = '';
  let productId = '';
  let mock: MockXendit;
  let svc: PaymentService;

  beforeAll(async () => {
    const m = await createTestMember('va');
    memberId = m.id;
    const p = await createTestProduct('VA Test', 500_000);
    productId = p.id;
  });

  afterAll(async () => {
    await cleanup(memberId, productId);
    await prisma.$disconnect();
  });

  it('PENDING: persists payment with vaNumber + expiry, no cancel called', async () => {
    mock = new MockXendit();
    const expectedVaId = uid();
    const expectedAcct = `9090${Math.floor(Math.random() * 1e12)}`;
    mock.vaReturn = {
      id: expectedVaId,
      accountNumber: expectedAcct,
      expirationDate: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      raw: {},
    };
    svc = new PaymentService(mock);
    const tx = await createPendingTransaction(memberId, productId, 500_000);

    const r = await svc.create(memberId, {
      transactionId: tx.id,
      paymentType: 'va',
      bank: 'BCA',
    });

    expect(r.paymentStatus).toBe('PENDING');
    expect(r.transactionStatus).toBe('PENDING');
    expect(r.vaNumber).toBe(expectedAcct);
    expect(r.bank).toBe('BCA');
    expect(r.expiredAt).not.toBeNull();
    expect(mock.cancelCalls).toHaveLength(0);
    expect(mock.vaArgs?.bank).toBe('BCA');
    expect(mock.vaArgs?.amount).toBe(r.amount);

    const persisted = await prisma.commercePayment.findUnique({ where: { id: r.paymentId } });
    expect(persisted?.status).toBe('PENDING');
    expect(persisted?.vaNumber).toBe(expectedAcct);
    expect(persisted?.xenditId).toBe(expectedVaId);
  });

  it('cancels existing PENDING VA before creating new one', async () => {
    mock = new MockXendit();
    const firstVaId = uid();
    mock.vaReturn = {
      id: firstVaId,
      accountNumber: uid(),
      expirationDate: new Date().toISOString(),
      raw: {},
    };
    svc = new PaymentService(mock);
    const tx = await createPendingTransaction(memberId, productId, 500_000);

    // first payment creates VA
    await svc.create(memberId, { transactionId: tx.id, paymentType: 'va', bank: 'BCA' });

    // second payment should cancel + create again
    const secondVaId = uid();
    const secondAcct = uid();
    mock.vaReturn = {
      id: secondVaId,
      accountNumber: secondAcct,
      expirationDate: new Date().toISOString(),
      raw: {},
    };
    const r2 = await svc.create(memberId, {
      transactionId: tx.id,
      paymentType: 'va',
      bank: 'BCA',
    });

    expect(mock.cancelCalls).toContain(firstVaId);
    expect(r2.vaNumber).toBe(secondAcct);

    const first = await prisma.commercePayment.findFirst({
      where: { transactionId: tx.id, xenditId: firstVaId },
    });
    expect(first?.status).toBe('CANCELED');
  });

  it('ignores INACTIVE_VIRTUAL_ACCOUNT_ERROR on cancel (legacy parity)', async () => {
    mock = new MockXendit();
    mock.vaReturn = {
      id: uid(),
      accountNumber: uid(),
      expirationDate: new Date().toISOString(),
      raw: {},
    };
    svc = new PaymentService(mock);
    const tx = await createPendingTransaction(memberId, productId, 500_000);
    await svc.create(memberId, { transactionId: tx.id, paymentType: 'va', bank: 'BNI' });

    mock.cancelError = { errorCode: 'INACTIVE_VIRTUAL_ACCOUNT_ERROR' };
    mock.vaReturn = {
      id: uid(),
      accountNumber: uid(),
      expirationDate: new Date().toISOString(),
      raw: {},
    };

    await expect(
      svc.create(memberId, { transactionId: tx.id, paymentType: 'va', bank: 'BNI' }),
    ).resolves.toBeDefined();
  });

  it('rejects when bank missing', async () => {
    mock = new MockXendit();
    svc = new PaymentService(mock);
    const tx = await createPendingTransaction(memberId, productId, 500_000);
    await expect(
      svc.create(memberId, { transactionId: tx.id, paymentType: 'va' }),
    ).rejects.toThrow(/bank/i);
  });
});
