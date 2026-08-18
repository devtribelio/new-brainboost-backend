import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { badRequest, ERROR_CODES } from '@bb/common/exceptions';
import { isUuid } from '@bb/common/utils/uuid.util';
import { commerceEvents } from '@bb/common/events/commerce-events';
import { fxRateService } from '@bb/common/services/fx-rate.service';
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
  /**
   * Currency `grossAmount`/`netAmount` are denominated in. Absent or 'IDR' means they
   * are already rupiah and pass through untouched. Anything else triggers normalisation
   * via `amountUsd` — see `normalizeToIdr`.
   */
  currency?: string;
  /**
   * The purchase converted to USD by the upstream provider. Required to normalise a
   * non-IDR purchase: one USD→IDR rate then covers every storefront, so we never carry
   * a per-currency rate table.
   */
  amountUsd?: number;
  affiliatorCode?: string; // explicit per-purchase attribution (last-touch), optional
  refundOfProviderEventId?: string; // for type=REFUND: the original purchase's providerEventId
  /** Subscription renewal vs first purchase — drives `subscriptionRenewed` notif. */
  isRenewal?: boolean;
  occurredAt?: string;
  raw?: unknown;
}

/** Product fields the ingest path needs: identity plus the catalog prices used as the FX floor. */
interface ResolvedProduct {
  id: string;
  price: number;
  iosPrice: number | null;
}

/** What `normalizeToIdr` settled on, both for the write and for the audit columns. */
interface NormalizedAmounts {
  gross: number;
  accepted: number;
  currency: string;
  amountLocal: number | null;
  amountUsd: number | null;
  fxRateIdr: number | null;
  fxRateSource: string | null;
}

/**
 * A converted amount this far from the catalog price is refused and replaced by the
 * catalog price. The live bug scored 0.0001x, so this net catches a broken rate (or a
 * provider changing its encoding) even if every other assumption fails. The band is wide
 * on purpose: foreign price tiers legitimately run 1.03x-1.26x the Indonesian one.
 */
const FX_SANITY_MIN = 0.25;
const FX_SANITY_MAX = 4;

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
    if (!input.providerEventId) throw badRequest(ERROR_CODES.INGEST_EVENT_ID_REQUIRED);
    if (input.type !== 'PURCHASE' && input.type !== 'REFUND') {
      throw badRequest(ERROR_CODES.INGEST_TYPE_INVALID);
    }

    if (input.type === 'REFUND') return this.handleRefund(input, cred);

    const memberId = await this.resolveMember(input.memberRef);
    if (!memberId) return { status: 'member_not_found' };
    const product = await this.resolveProduct(input.productRef);
    if (!product) return { status: 'product_not_found' };
    const productId = product.id;

    // Idempotency: one transaction per (provider, providerEventId).
    const existing = await prisma.commerceTransaction.findUnique({
      where: {
        provider_providerEventId: { provider: cred.name, providerEventId: input.providerEventId },
      },
      select: { id: true },
    });
    if (existing) return { status: 'duplicate', transactionId: existing.id };

    const voucherAmount = Math.max(0, Math.round(input.voucherAmount ?? 0));
    // Every amount written below is IDR. For a foreign storefront that means converting
    // first — `normalizeToIdr` also returns the FX audit trail for the payment row.
    const money = await this.normalizeToIdr(input, product);
    const { gross, accepted } = money;

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
              attributionKey: input.attributionKey ?? input.providerEventId,
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
              // FX audit: null on the IDR path, populated whenever a conversion happened
              // so the rate behind `amount` stays reproducible after the live rate moves.
              currency: money.currency,
              amountLocal: money.amountLocal,
              amountUsd: money.amountUsd,
              fxRateIdr: money.fxRateIdr,
              fxRateSource: money.fxRateSource,
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
          where: {
            provider_providerEventId: {
              provider: cred.name,
              providerEventId: input.providerEventId,
            },
          },
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
      const attributionKey = input.attributionKey ?? input.providerEventId;
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
      ? await attributionService.resolveOverrideAffiliatorMemberId(
          memberId,
          input.affiliatorCode,
          productId,
        )
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
    });

    return { status: 'committed', transactionId: txId, paymentId };
  }

  private async handleRefund(
    input: NormalizedPurchase,
    cred: VerifiedCredential,
  ): Promise<IngestResult> {
    if (!cred.canIngestRefund) return { status: 'refund_not_permitted' };
    const originalEventId = input.refundOfProviderEventId;
    if (!originalEventId) throw badRequest(ERROR_CODES.INGEST_REFUND_REFERENCE_REQUIRED);

    const tx = await prisma.commerceTransaction.findUnique({
      where: {
        provider_providerEventId: { provider: cred.name, providerEventId: originalEventId },
      },
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
      data: {
        status: COMMISSION_STATUS.VOIDED,
        voidedAt: new Date(),
        voidedReason: `refund:${input.providerEventId}`,
      },
    });
    await prisma.commerceTransaction.update({ where: { id: tx.id }, data: { status: 'REFUNDED' } });

    // Revoke course access so `isPurchased` flips back to false. Soft-cancel, not
    // delete: the row carries progress and purchase history that a refund dispute
    // needs, and every read path filters on `isCanceled` (see
    // `@bb/domain/commerce/enrollment`). A later re-purchase revives this same row.
    // Idempotent: updateMany matches 0 rows if already revoked.
    let revokedEnrollments = 0;
    // Revoke for any course-backed product (course + mini_course). Mirror of the
    // grant gate in payment-success.listener — key on the linked course row, not type.
    if (tx.product?.course) {
      const revoked = await prisma.courseEnrollment.updateMany({
        where: { memberId: tx.memberId, courseId: tx.product.course.id, isCanceled: false },
        data: {
          isCanceled: true,
          cancelationReason: `refund:${input.providerEventId}`,
          canceledAt: new Date(),
        },
      });
      revokedEnrollments = revoked.count;
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

  /**
   * Bring a purchase onto the IDR scale every downstream consumer assumes.
   *
   * IDR purchases (the overwhelming majority) short-circuit: the figures are already
   * rupiah and no FX columns are written. For a foreign storefront the local figure is
   * useless as rupiah, so the amount is rebuilt from the provider's USD conversion:
   *
   *     amountIdr = round(amountUsd x usdIdrRate)
   *
   * The store's cut is re-applied as the RATIO the provider reported rather than a fresh
   * percentage, so whatever `computeNetAmount` decided upstream survives conversion.
   *
   * Falls back to the catalog price when the event carries no usable USD figure, when
   * every FX layer failed, or when the result fails the sanity band. That fallback is
   * logged at error: it means an amount was invented rather than converted, which
   * reporting needs to be able to find.
   */
  private async normalizeToIdr(
    input: NormalizedPurchase,
    product: ResolvedProduct,
  ): Promise<NormalizedAmounts> {
    const rawGross = Math.max(0, input.grossAmount);
    const takehomeRatio =
      input.netAmount != null && rawGross > 0
        ? Math.max(0, Math.min(1, input.netAmount / rawGross))
        : 1;

    const currency = (input.currency ?? 'IDR').toUpperCase();
    if (currency === 'IDR') {
      const gross = Math.round(rawGross);
      return {
        gross,
        accepted:
          input.netAmount != null
            ? Math.max(0, Math.min(gross, Math.round(input.netAmount)))
            : gross,
        currency,
        amountLocal: null,
        amountUsd: null,
        fxRateIdr: null,
        fxRateSource: null,
      };
    }

    const catalog = product.iosPrice ?? product.price;
    const withFallback = (reason: string): NormalizedAmounts => {
      // Priced product: its catalog price is the best available stand-in.
      if (catalog > 0) {
        logger.error(
          { currency, grossLocal: rawGross, amountUsd: input.amountUsd, catalog, reason },
          '[ingest] FX unavailable — falling back to catalog price',
        );
        return {
          gross: catalog,
          accepted: Math.floor(catalog * takehomeRatio),
          currency,
          amountLocal: rawGross,
          amountUsd: input.amountUsd ?? null,
          fxRateIdr: null,
          fxRateSource: 'catalog_fallback',
        };
      }
      // No catalog price to fall back to (free/unpriced product). Keep the local figure
      // rather than writing 0 — an unconverted amount is at least traceable via
      // `fx_rate_source`, whereas a zero silently reads as a legitimate free sale.
      logger.error(
        { currency, grossLocal: rawGross, amountUsd: input.amountUsd, reason },
        '[ingest] FX unavailable and product has no catalog price — amount left unconverted',
      );
      const local = Math.round(rawGross);
      return {
        gross: local,
        accepted: Math.floor(local * takehomeRatio),
        currency,
        amountLocal: rawGross,
        amountUsd: input.amountUsd ?? null,
        fxRateIdr: null,
        fxRateSource: 'unconverted',
      };
    };

    if (input.amountUsd == null || input.amountUsd <= 0)
      return withFallback('no usable USD amount');

    const at = input.occurredAt ? new Date(input.occurredAt) : new Date();
    const fx = await fxRateService.getUsdIdr(Number.isNaN(at.getTime()) ? new Date() : at);
    if (!fx) return withFallback('no FX rate from any source');

    const gross = Math.round(input.amountUsd * fx.rate);
    // The sanity band needs a catalog price to compare against; an unpriced product has no
    // reference, so the converted value is taken as-is rather than refused against zero.
    if (catalog > 0) {
      const ratio = gross / catalog;
      if (ratio < FX_SANITY_MIN || ratio > FX_SANITY_MAX) {
        return withFallback(`converted amount ${gross} is ${ratio.toFixed(4)}x catalog`);
      }
    }

    logger.info(
      {
        currency,
        amountLocal: rawGross,
        amountUsd: input.amountUsd,
        fxRate: fx.rate,
        fxSource: fx.source,
        amountIdr: gross,
      },
      '[ingest] foreign-currency purchase normalized to IDR',
    );

    return {
      gross,
      accepted: Math.floor(gross * takehomeRatio),
      currency,
      amountLocal: rawGross,
      amountUsd: input.amountUsd,
      fxRateIdr: fx.rate,
      fxRateSource: fx.source,
    };
  }

  private async resolveMember(ref: NormalizedPurchase['memberRef']): Promise<string | null> {
    // `isUuid` guard is what makes the `byEmail` fallback reachable at all:
    // `members.id` is `@db.Uuid`, so handing Prisma a non-UUID string (e.g.
    // RevenueCat's `$RCAnonymousID:…` app_user_id) throws P2023 → 500 → the
    // provider retries forever and the email branch below never runs.
    if (isUuid(ref?.byId)) {
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

  /**
   * Returns the product row, not just its id: the catalog price is the floor of the FX
   * chain, so the amount math needs it on every ingest.
   */
  private async resolveProduct(
    ref: NormalizedPurchase['productRef'],
  ): Promise<ResolvedProduct | null> {
    const select = { id: true, price: true, iosPrice: true } as const;
    // Same P2023 guard as resolveMember — a non-UUID `byId` must fall through to
    // the SKU lookup, not 500.
    if (isUuid(ref?.byId)) {
      const p = await prisma.product.findUnique({ where: { id: ref.byId }, select });
      if (p) return p;
    }
    if (ref?.bySku) {
      // Matches BOTH store SKUs: keying on `iosProductId` alone meant a Google Play
      // purchase resolved to nothing and returned `product_not_found` — the member paid
      // and never got access, with the provider given a 200 so it never retried.
      const p = await prisma.product.findFirst({
        where: { OR: [{ iosProductId: ref.bySku }, { androidProductId: ref.bySku }] },
        // Deterministic pick if a SKU were ever duplicated across the two columns:
        // oldest row wins, so a re-delivery always resolves to the same product.
        orderBy: { createdAt: 'asc' },
        select,
      });
      if (p) return p;
    }
    return null;
  }
}

export const purchaseIngestService = new PurchaseIngestService();
