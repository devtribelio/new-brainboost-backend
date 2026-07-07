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
  providerEventId: string; // idempotency (provider txn/event id) — per-EVENT (one transaction row)
  /**
   * Commission idempotency key (B-2). Identifies the underlying *purchase* across
   * re-settles that mint a fresh `providerEventId` (delete+rebuy, renewal,
   * restore, RC re-sync burst) — e.g. Apple's stable `original_transaction_id`.
   * Commission is claimed once per `(provider, attributionKey)`, so a re-settle
   * grants enrollment again but never double-pays. Defaults to `providerEventId`
   * when the channel has no stabler key (each event then claims independently).
   */
  attributionKey?: string;
  type: 'PURCHASE' | 'REFUND';
  memberRef: { byId?: string; byEmail?: string };
  productRef: { byId?: string; bySku?: string };
  grossAmount: number;
  /**
   * What the channel actually settles to us (gross minus store commission +
   * tax). Optional — adapters compute it when the upstream payload exposes the
   * cuts (e.g. RevenueCat's commission_percentage / tax_percentage). When
   * omitted, `acceptedAmount` falls back to `grossAmount` (no regression for
   * channels that don't carry the data).
   *
   * `amount` (and the affiliate base) stays on gross — Apple/Google's cut is a
   * platform cost to Brainboost, not a deduction the affiliator should bear.
   */
  netAmount?: number;
  voucherAmount?: number;
  currency?: string;
  affiliatorCode?: string; // explicit per-purchase attribution (last-touch), optional
  refundOfProviderEventId?: string; // for type=REFUND: the original purchase's providerEventId
  /** Subscription renewal vs first purchase — drives `subscriptionRenewed` notif. */
  isRenewal?: boolean;
  /**
   * Provider subscription facts (BE-13): providerRef = store original_transaction_id,
   * expirationAtMs = authoritative entitlement expiry. Forwarded on the success
   * event so the subscription activation listener binds/extends the sub correctly.
   */
  subscription?: { providerRef?: string | null; expirationAtMs?: number | null };
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

    // Subscription products claim commission PER PERIOD (BE-13): the stable
    // original_transaction_id would let the first period's claim block every
    // renewal's commission forever, but renewals must pay (at the renewal rate,
    // BE-09). providerEventId (= store transaction_id) is unique per period, and
    // same-period restores/re-syncs reuse it → they short-circuit as duplicates
    // above before ever reaching the claim. Retail keeps the stable key.
    const isSubscriptionProduct =
      (await prisma.subscriptionPlan.count({ where: { productId } })) > 0;
    const attributionKey = isSubscriptionProduct
      ? input.providerEventId
      : (input.attributionKey ?? input.providerEventId);

    const gross = Math.max(0, Math.round(input.grossAmount));
    const voucherAmount = Math.max(0, Math.round(input.voucherAmount ?? 0));
    // `acceptedAmount` = net settlement (after store cut + tax). When the
    // adapter didn't compute it, mirror `gross` so reporting stays non-null and
    // identical to legacy behavior.
    const accepted = input.netAmount != null
      ? Math.max(0, Math.min(gross, Math.round(input.netAmount)))
      : gross;

    // RevenueCat can deliver a burst of events in the same instant (IAP restore
    // flood). The order code is count-derived → concurrent inserts collide on
    // the `code` unique. A blanket "any P2002 → duplicate" is WRONG: a code
    // collision would be silently dropped as a duplicate (member paid, no
    // access). So on P2002 we disambiguate by the idempotency key: if a tx with
    // this (provider, providerEventId) exists it is a genuine redelivery →
    // duplicate; otherwise it was a code collision → retry with a jittered code.
    const MAX_ATTEMPTS = 5;
    let txId = '';
    let paymentId = '';
    for (let attempt = 1; ; attempt++) {
      const code = await generateOrderCode(new Date(), { jitter: attempt > 1 });
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
              attributionKey,
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
              acceptedAmount: accepted,
              // Audit trail: full upstream payload so we can later reconcile
              // unexpected `acceptedAmount` values, replay fee math when RC
              // changes encoding, or cross-reference with Apple settlement
              // reports. Mirrors `commerce_payments.log_response` on the
              // Xendit path (which stores the provider's update payload).
              logRequest: (input.raw ?? undefined) as object | undefined,
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
        break;
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') throw e;

        // Genuine idempotency duplicate (provider, providerEventId already used)?
        const dup = await prisma.commerceTransaction.findUnique({
          where: { provider_providerEventId: { provider: cred.name, providerEventId: input.providerEventId } },
          select: { id: true },
        });
        if (dup) return { status: 'duplicate', transactionId: dup.id };

        // Not the idempotency key → order-code collision. Retry with jitter.
        if (attempt < MAX_ATTEMPTS) continue;
        throw e;
      }
    }

    // Commission eligibility (B-2): "first settle wins" per (provider, attributionKey).
    // A re-settle of the same underlying purchase — delete+rebuy, renewal, restore,
    // or an RC re-sync burst — shares the attributionKey but arrives with a fresh
    // providerEventId/paymentId, so the per-payment commission dedup can't catch it.
    // The unique claim row makes only the FIRST settle commission-eligible; the rest
    // keep their enrollment but pay nothing. Race-proof: a burst of N concurrent
    // events all attempt the insert, exactly one wins, the others get P2002.
    let affiliateEligible = cred.triggersAffiliate;
    if (affiliateEligible) {
      try {
        await prisma.affiliateAttributionClaim.create({
          data: { provider: cred.name, attributionKey, paymentId },
        });
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') throw e;
        affiliateEligible = false;
        logger.info(
          { provider: cred.name, attributionKey, paymentId },
          '[ingest] attribution already claimed for this purchase — commission skipped',
        );
      }
    }

    // Affiliate override only resolved when this settle is the commission-bearing one.
    // Pass productId so per-product attribution (B-5) prefers a visit for THIS product.
    const overrideAffiliatorMemberId = affiliateEligible
      ? await attributionService.resolveOverrideAffiliatorMemberId(memberId, input.affiliatorCode, productId)
      : null;

    commerceEvents.emit('commerce.payment.success', {
      paymentId,
      transactionId: txId,
      memberId,
      productId,
      amount: gross,
      // Only forward acceptedAmount when the channel actually derived it (RC
      // takehome). For events without a net signal, leave undefined → listener
      // falls back to `amount` (gross) and existing channels are unaffected.
      acceptedAmount: input.netAmount != null ? accepted : undefined,
      voucherAmount,
      voucherId: null,
      affiliatorId: null,
      programId: null,
      attributedAffiliatorMemberId: overrideAffiliatorMemberId, // listener maps → engine override
      affiliateEligible, // gate: false → enrollment yes, commission no (channel off OR re-settle)
      channel: cred.name, // e.g. "revenuecat", "scalev", "lynkid" — used for per-channel hold
      isRenewal: input.isRenewal,
      // Subscription facts passthrough (BE-13) — undefined for non-subscription channels.
      subscription: input.subscription
        ? {
            providerRef: input.subscription.providerRef ?? null,
            expiresAt:
              input.subscription.expirationAtMs != null
                ? new Date(input.subscription.expirationAtMs)
                : null,
          }
        : undefined,
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
        productId: true,
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
    // Revoke for any course-backed product (course + mini_course). Mirror of the
    // grant gate in payment-success.listener — key on the linked course row, not type.
    if (tx.product?.course) {
      const del = await prisma.courseEnrollment.deleteMany({
        where: { memberId: tx.memberId, courseId: tx.product.course.id },
      });
      revokedEnrollments = del.count;
    }

    logger.info(
      { txId: tx.id, voided: res.count, revokedEnrollments },
      '[ingest] refund voided commissions + revoked enrollment',
    );

    commerceEvents.emit('commerce.payment.refunded', {
      paymentId: paymentIds[0] ?? null,
      transactionId: tx.id,
      memberId: tx.memberId,
      productId: tx.productId,
      providerEventId: input.providerEventId,
    });

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
      // A store SKU can arrive from either platform — Android SKUs never resolved
      // before this OR (BE-13); both columns are unique so findFirst is exact.
      const p = await prisma.product.findFirst({
        where: { OR: [{ iosProductId: ref.bySku }, { androidProductId: ref.bySku }] },
        select: { id: true },
      });
      if (p) return p.id;
    }
    return null;
  }
}

export const purchaseIngestService = new PurchaseIngestService();
