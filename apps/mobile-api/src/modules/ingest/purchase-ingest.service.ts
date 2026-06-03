import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { BadRequestException } from '@bb/common/exceptions';
import { commerceEvents } from '@bb/common/events/commerce-events';
import { generateOrderCode } from '@bb/domain/commerce/utils/generate-order-code';
import { attributionService } from '@bb/domain/affiliate/attribution.service';
import { COMMISSION_STATUS } from '@bb/domain/affiliate/constants';
import type { VerifiedCredential } from './credential.service';

/** Provider-agnostic purchase shape. Adapters (edge functions) map their payload to this. */
export interface NormalizedPurchase {
  providerEventId: string; // idempotency (provider txn/event id)
  type: 'PURCHASE' | 'REFUND';
  memberRef: { byId?: string; byEmail?: string };
  productRef: { byId?: string; bySku?: string };
  grossAmount: number;
  voucherAmount?: number;
  currency?: string;
  affiliatorCode?: string; // explicit per-purchase attribution (last-touch), optional
  refundOfProviderEventId?: string; // for type=REFUND: the original purchase's providerEventId
  occurredAt?: string;
  raw?: unknown;
}

export interface IngestResult {
  status:
    | 'committed'
    | 'duplicate'
    | 'refunded'
    | 'refund_not_permitted'
    | 'refund_target_not_found'
    | 'member_not_found'
    | 'product_not_found';
  transactionId?: string;
  paymentId?: string;
  voidedCommissions?: number;
}

export class PurchaseIngestService {
  async ingest(input: NormalizedPurchase, cred: VerifiedCredential): Promise<IngestResult> {
    if (!input.providerEventId) throw new BadRequestException('providerEventId is required');
    if (input.type !== 'PURCHASE' && input.type !== 'REFUND') {
      throw new BadRequestException('type must be PURCHASE or REFUND');
    }

    if (input.type === 'REFUND') return this.handleRefund(input, cred);

    const memberId = await this.resolveMember(input.memberRef);
    if (!memberId) return { status: 'member_not_found' };
    const productId = await this.resolveProduct(input.productRef);
    if (!productId) return { status: 'product_not_found' };

    // Idempotency: one transaction per (provider, providerEventId).
    const existing = await prisma.commerceTransaction.findUnique({
      where: { provider_providerEventId: { provider: cred.name, providerEventId: input.providerEventId } },
      select: { id: true },
    });
    if (existing) return { status: 'duplicate', transactionId: existing.id };

    const gross = Math.max(0, Math.round(input.grossAmount));
    const voucherAmount = Math.max(0, Math.round(input.voucherAmount ?? 0));
    const code = await generateOrderCode();

    let txId = '';
    let paymentId = '';
    try {
      const created = await prisma.$transaction(async (db) => {
        const tx = await db.commerceTransaction.create({
          data: {
            code,
            memberId,
            productId,
            itemTotal: gross,
            amount: gross,
            voucherAmount,
            provider: cred.name,
            providerEventId: input.providerEventId,
            status: 'PAID',
            paidAt: new Date(),
          },
          select: { id: true, productId: true, amount: true, voucherAmount: true },
        });
        const payment = await db.commercePayment.create({
          data: {
            transactionId: tx.id,
            memberId,
            paymentType: cred.name,
            amount: gross,
            acceptedAmount: gross,
            status: 'SUCCESS',
            paidAt: new Date(),
            activeSlotTxId: tx.id, // occupy slot — invariant: every active payment holds its tx slot
          },
          select: { id: true },
        });
        await db.commercePaymentEvent.create({
          data: { paymentId: payment.id, source: 'ingest', toStatus: 'SUCCESS' },
        });
        return { tx, payment };
      });
      txId = created.tx.id;
      paymentId = created.payment.id;
    } catch (e) {
      // race on the unique (provider, providerEventId) → treat as duplicate
      if ((e as { code?: string }).code === 'P2002') {
        const dup = await prisma.commerceTransaction.findUnique({
          where: { provider_providerEventId: { provider: cred.name, providerEventId: input.providerEventId } },
          select: { id: true },
        });
        return { status: 'duplicate', transactionId: dup?.id };
      }
      throw e;
    }

    // Affiliate override only resolved when the channel is allowed to pay commission.
    const overrideAffiliatorMemberId = cred.triggersAffiliate
      ? await attributionService.resolveOverrideAffiliatorMemberId(memberId, input.affiliatorCode)
      : null;

    commerceEvents.emit('commerce.payment.success', {
      paymentId,
      transactionId: txId,
      memberId,
      productId,
      amount: gross,
      voucherAmount,
      voucherId: null,
      affiliatorId: null,
      programId: null,
      attributedAffiliatorMemberId: overrideAffiliatorMemberId, // listener maps → engine override
      affiliateEligible: cred.triggersAffiliate, // gate: false → enrollment yes, commission no
    });

    return { status: 'committed', transactionId: txId, paymentId };
  }

  private async handleRefund(input: NormalizedPurchase, cred: VerifiedCredential): Promise<IngestResult> {
    if (!cred.canIngestRefund) return { status: 'refund_not_permitted' };
    const originalEventId = input.refundOfProviderEventId;
    if (!originalEventId) throw new BadRequestException('refundOfProviderEventId required for REFUND');

    const tx = await prisma.commerceTransaction.findUnique({
      where: { provider_providerEventId: { provider: cred.name, providerEventId: originalEventId } },
      select: {
        id: true,
        memberId: true,
        payments: { select: { id: true } },
        product: { select: { type: true, course: { select: { id: true } } } },
      },
    });
    if (!tx) return { status: 'refund_target_not_found' };

    const paymentIds = tx.payments.map((p) => p.id);
    const res = await prisma.affiliateCommission.updateMany({
      where: { paymentId: { in: paymentIds }, status: { not: COMMISSION_STATUS.VOIDED } },
      data: { status: COMMISSION_STATUS.VOIDED, voidedAt: new Date(), voidedReason: `refund:${input.providerEventId}` },
    });
    await prisma.commerceTransaction.update({ where: { id: tx.id }, data: { status: 'REFUNDED' } });

    // Revoke course access so `isPurchased` flips back to false. All read paths
    // (product list, course detail, media gating) key on enrollment existence,
    // so a hard delete is the single point that revokes access everywhere. A
    // later re-purchase re-creates the enrollment via the success listener.
    // Idempotent: deleteMany is a no-op if already revoked.
    let revokedEnrollments = 0;
    if (tx.product?.type === 'course' && tx.product.course) {
      const del = await prisma.courseEnrollment.deleteMany({
        where: { memberId: tx.memberId, courseId: tx.product.course.id },
      });
      revokedEnrollments = del.count;
    }

    logger.info(
      { txId: tx.id, voided: res.count, revokedEnrollments },
      '[ingest] refund voided commissions + revoked enrollment',
    );
    return { status: 'refunded', transactionId: tx.id, voidedCommissions: res.count };
  }

  private async resolveMember(ref: NormalizedPurchase['memberRef']): Promise<string | null> {
    if (ref?.byId) {
      const m = await prisma.member.findUnique({ where: { id: ref.byId }, select: { id: true } });
      if (m) return m.id;
    }
    if (ref?.byEmail) {
      const m = await prisma.member.findUnique({
        where: { email: ref.byEmail.toLowerCase() },
        select: { id: true },
      });
      if (m) return m.id;
    }
    return null;
  }

  private async resolveProduct(ref: NormalizedPurchase['productRef']): Promise<string | null> {
    if (ref?.byId) {
      const p = await prisma.product.findUnique({ where: { id: ref.byId }, select: { id: true } });
      if (p) return p.id;
    }
    if (ref?.bySku) {
      const p = await prisma.product.findUnique({ where: { iapProductId: ref.bySku }, select: { id: true } });
      if (p) return p.id;
    }
    return null;
  }
}

export const purchaseIngestService = new PurchaseIngestService();
