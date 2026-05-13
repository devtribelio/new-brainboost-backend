import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PaymentService } from '@/modules/commerce/payment.service';
import { prisma } from '@/config/prisma';
import type {
  IXenditService,
  XenditEwalletOptions,
  XenditEwalletResult,
} from '@/common/services/xendit.service';
import { createTestMember, createTestProduct, createPendingTransaction, cleanup } from './fixtures';
import { env } from '@/config/env';

function uid(): string {
  return `xnd-${Math.random().toString(36).slice(2, 12)}`;
}

class MockXendit implements IXenditService {
  ewArgs: XenditEwalletOptions | null = null;
  ewReturn: XenditEwalletResult = {
    id: uid(),
    status: 'PENDING',
    checkoutUrl: 'https://xendit.example/checkout',
    deeplinkUrl: 'ovo://pay/xyz',
    qrString: 'QR-STRING-TEST',
    raw: {},
  };
  generateExternalId(p = 'commerce'): string {
    return `${p}-${Math.random()}`;
  }
  verifyCallbackToken(): boolean {
    return true;
  }
  async createCardCharge(): Promise<never> {
    throw new Error('not called');
  }
  async createCallbackVa(): Promise<never> {
    throw new Error('not called');
  }
  async cancelVa() {
    return { id: 'x', status: 'INACTIVE' };
  }
  async getVa() {
    return { status: 'INACTIVE', raw: {} };
  }
  async createEwalletCharge(opts: XenditEwalletOptions) {
    this.ewArgs = opts;
    return this.ewReturn;
  }
}

describe('PaymentService — eWallet dispatch', () => {
  let memberId = '';
  let productId = '';

  beforeAll(async () => {
    const m = await createTestMember('ew');
    memberId = m.id;
    const p = await createTestProduct('eWallet Test', 500_000);
    productId = p.id;
  });

  afterAll(async () => {
    await cleanup(memberId, productId);
    await prisma.$disconnect();
  });

  it('OVO: PENDING + redirectUrl + 2-min expiry', async () => {
    const mock = new MockXendit();
    const svc = new PaymentService(mock);
    const tx = await createPendingTransaction(memberId, productId, 500_000);

    const r = await svc.create(memberId, {
      transactionId: tx.id,
      paymentType: 'eWallet',
      ewalletType: 'OVO',
      ewalletPhone: '+628123456789',
    });

    expect(r.paymentStatus).toBe('PENDING');
    expect(r.ewalletType).toBe('OVO');
    expect(r.redirectUrl).toBe('https://xendit.example/checkout');
    expect(r.deeplinkUrl).toBe('ovo://pay/xyz');
    expect(r.qrString).toBe('QR-STRING-TEST');
    expect(mock.ewArgs?.ewalletType).toBe('OVO');
    expect(mock.ewArgs?.phone).toBe('+628123456789');

    // 2 min expiry
    const diffMs = (r.expiredAt!.getTime() - Date.now()) / 1000;
    expect(diffMs).toBeGreaterThan(env.commerce.ewalletExpiryMin.default * 60 - 5);
    expect(diffMs).toBeLessThan(env.commerce.ewalletExpiryMin.default * 60 + 5);
  });

  it('DANA: 30-min expiry', async () => {
    const mock = new MockXendit();
    const svc = new PaymentService(mock);
    const tx = await createPendingTransaction(memberId, productId, 500_000);

    const r = await svc.create(memberId, {
      transactionId: tx.id,
      paymentType: 'eWallet',
      ewalletType: 'DANA',
    });

    const diffMs = (r.expiredAt!.getTime() - Date.now()) / 1000;
    expect(diffMs).toBeGreaterThan(env.commerce.ewalletExpiryMin.dana * 60 - 5);
    expect(diffMs).toBeLessThan(env.commerce.ewalletExpiryMin.dana * 60 + 5);
  });

  it('LINKAJA: 5-min expiry', async () => {
    const mock = new MockXendit();
    const svc = new PaymentService(mock);
    const tx = await createPendingTransaction(memberId, productId, 500_000);

    const r = await svc.create(memberId, {
      transactionId: tx.id,
      paymentType: 'eWallet',
      ewalletType: 'LINKAJA',
    });
    const diffMs = (r.expiredAt!.getTime() - Date.now()) / 1000;
    expect(diffMs).toBeGreaterThan(env.commerce.ewalletExpiryMin.linkaja * 60 - 5);
    expect(diffMs).toBeLessThan(env.commerce.ewalletExpiryMin.linkaja * 60 + 5);
  });

  it('SUCCESS path (rare): tx flipped to PAID + event emitted', async () => {
    const mock = new MockXendit();
    mock.ewReturn = { id: uid(), status: 'SUCCESS', raw: { status: 'SUCCEEDED' } };
    const svc = new PaymentService(mock);
    const tx = await createPendingTransaction(memberId, productId, 500_000);

    const r = await svc.create(memberId, {
      transactionId: tx.id,
      paymentType: 'eWallet',
      ewalletType: 'DANA',
    });

    expect(r.paymentStatus).toBe('SUCCESS');
    expect(r.transactionStatus).toBe('PAID');
    const after = await prisma.commerceTransaction.findUnique({ where: { id: tx.id } });
    expect(after?.status).toBe('PAID');
  });

  it('rejects when ewalletType missing', async () => {
    const mock = new MockXendit();
    const svc = new PaymentService(mock);
    const tx = await createPendingTransaction(memberId, productId, 500_000);
    await expect(
      svc.create(memberId, { transactionId: tx.id, paymentType: 'eWallet' }),
    ).rejects.toThrow(/ewalletType/i);
  });
});
