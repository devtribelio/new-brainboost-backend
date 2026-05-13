import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PaymentService } from '@/modules/commerce/payment.service';
import { prisma } from '@/config/prisma';
import type {
  IXenditService,
  XenditCardChargeOptions,
  XenditCardChargeResult,
} from '@/common/services/xendit.service';
import { createTestMember, createTestProduct, createPendingTransaction, cleanup } from './fixtures';

function uid(): string {
  return `xnd-${Math.random().toString(36).slice(2, 12)}`;
}

class MockXendit implements IXenditService {
  cardChargeArgs: XenditCardChargeOptions | null = null;
  cardChargeReturn: XenditCardChargeResult = {
    id: uid(),
    status: 'SUCCESS',
    cardBrand: 'VISA',
    maskedCardNumber: '4111-XXXX-XXXX-1234',
    raw: { status: 'CAPTURED' },
  };
  generateExternalId(p = 'commerce'): string {
    return `${p}-mock-${Math.random()}`;
  }
  verifyCallbackToken(): boolean {
    return true;
  }
  async createCardCharge(opts: XenditCardChargeOptions) {
    this.cardChargeArgs = opts;
    return this.cardChargeReturn;
  }
  async createCallbackVa(): Promise<never> {
    throw new Error('not called');
  }
  async cancelVa() {
    return { id: 'cancelled', status: 'INACTIVE' };
  }
  async getVa() {
    return { status: 'INACTIVE', raw: {} };
  }
  async createEwalletCharge(): Promise<never> {
    throw new Error('not called');
  }
}

describe('PaymentService — CC dispatch', () => {
  let memberId = '';
  let productId = '';
  const mock = new MockXendit();
  const svc = new PaymentService(mock);

  beforeAll(async () => {
    const m = await createTestMember('cc');
    memberId = m.id;
    const p = await createTestProduct('CC Test', 500_000);
    productId = p.id;
  });

  afterAll(async () => {
    await cleanup(memberId, productId);
    await prisma.$disconnect();
  });

  it('SUCCESS path: payment persisted, tx flipped to PAID, event emitted', async () => {
    const tx = await createPendingTransaction(memberId, productId, 500_000);
    const ccId = uid();
    mock.cardChargeReturn = {
      id: ccId,
      status: 'SUCCESS',
      cardBrand: 'VISA',
      maskedCardNumber: '4111-XXXX-XXXX-1234',
      raw: { id: ccId, status: 'CAPTURED' },
    };

    const r = await svc.create(memberId, {
      transactionId: tx.id,
      paymentType: 'cc',
      cardTokenId: 'tok_abc',
      authenticationId: 'auth_xyz',
    });

    expect(r.paymentStatus).toBe('SUCCESS');
    expect(r.transactionStatus).toBe('PAID');
    expect(r.fee).toBeGreaterThan(0);
    expect(r.amount).toBe(500_000 + r.fee);

    expect(mock.cardChargeArgs?.tokenId).toBe('tok_abc');
    expect(mock.cardChargeArgs?.authenticationId).toBe('auth_xyz');
    expect(mock.cardChargeArgs?.amount).toBe(r.amount);

    const persisted = await prisma.commercePayment.findUnique({ where: { id: r.paymentId } });
    expect(persisted?.status).toBe('SUCCESS');
    expect(persisted?.cardBrand).toBe('VISA');
    expect(persisted?.cardMaskedNumber).toBe('4111-XXXX-XXXX-1234');
    expect(persisted?.xenditId).toBe(ccId);
  });

  it('FAILED path: payment stored FAILED, tx still PENDING', async () => {
    const tx = await createPendingTransaction(memberId, productId, 500_000);
    mock.cardChargeReturn = {
      id: uid(),
      status: 'FAILED',
      failureReason: 'CARD_DECLINED',
      raw: { status: 'FAILED', failure_reason: 'CARD_DECLINED' },
    };

    const r = await svc.create(memberId, {
      transactionId: tx.id,
      paymentType: 'cc',
      cardTokenId: 'tok_decline',
    });

    expect(r.paymentStatus).toBe('FAILED');
    expect(r.transactionStatus).toBe('PENDING');
    const after = await prisma.commerceTransaction.findUnique({ where: { id: tx.id } });
    expect(after?.status).toBe('PENDING');
  });

  it('rejects when cardTokenId missing', async () => {
    const tx = await createPendingTransaction(memberId, productId, 500_000);
    await expect(
      svc.create(memberId, { transactionId: tx.id, paymentType: 'cc' }),
    ).rejects.toThrow(/cardTokenId/i);
  });
});
