import { EventEmitter } from 'node:events';
import { logger } from '@bb/common/config/logger';

export interface CommercePaymentSuccessEvent {
  paymentId: string;
  transactionId: string;
  memberId: string;
  productId: string;
  amount: number;
  /**
   * Net that lands in our pocket (post Apple/Google cut, post Xendit MDR).
   * When present, the affiliate listener computes commission from this — so
   * affiliator rate × IAP_net ≈ rate × web_price (since IAP price is marked
   * up to offset Apple's cut, the markup nets out of the commission base).
   * Optional: legacy/web channels that don't expose settlement amount fall
   * back to `amount` (gross), preserving prior behavior.
   */
  acceptedAmount?: number;
  voucherAmount: number;
  voucherId?: string | null;
  affiliatorId?: string | null;
  programId?: string | null;
  /** Per-purchase override: Member behind the link used at checkout (supersedes inviter). */
  attributedAffiliatorMemberId?: string | null;
  /**
   * Whether this channel may generate affiliate commission. `undefined` = eligible (web/native).
   * Ingestion sets it from the channel's `triggersAffiliate` toggle; `false` → listener still
   * grants enrollment/voucher but does NOT pay commission.
   */
  affiliateEligible?: boolean;
  /**
   * Payment channel / provider identifier: "xendit" | "revenuecat" | "scalev" | "lynkid".
   * `undefined` or `null` = legacy / web checkout (pre-channel tagging).
   * Used by the affiliate pending-to-balance cron to apply per-channel hold windows
   * (IAP channels settle monthly → longer hold than Xendit).
   */
  channel?: string | null;
  /**
   * Subscription renewal (vs first purchase). RC `RENEWAL` event sets this; other
   * channels leave it undefined. Notification listener emits `subscriptionRenewed`
   * instead of `paymentSuccess` when true. Does not affect enrollment/commission.
   */
  isRenewal?: boolean;
}

export interface CommercePaymentRefundedEvent {
  paymentId?: string | null;
  transactionId: string;
  memberId: string;
  productId?: string | null;
  /** Provider-side refund event id (idempotency / audit). */
  providerEventId?: string;
}

export interface CommercePaymentExpiredEvent {
  paymentId: string;
  transactionId: string;
}

export interface CommercePaymentFailedEvent {
  paymentId: string;
  transactionId: string;
  reason?: string;
}

export type CommerceEventMap = {
  'commerce.payment.success': CommercePaymentSuccessEvent;
  'commerce.payment.refunded': CommercePaymentRefundedEvent;
  'commerce.payment.expired': CommercePaymentExpiredEvent;
  'commerce.payment.failed': CommercePaymentFailedEvent;
};

class TypedEmitter {
  private bus = new EventEmitter();

  emit<K extends keyof CommerceEventMap>(event: K, payload: CommerceEventMap[K]): void {
    this.bus.emit(event, payload);
  }

  on<K extends keyof CommerceEventMap>(
    event: K,
    listener: (payload: CommerceEventMap[K]) => void | Promise<void>,
  ): void {
    this.bus.on(event, (payload: CommerceEventMap[K]) => {
      Promise.resolve(listener(payload)).catch((err) => {
        // Via `logger`, NOT console: emit() is synchronous, so a listener that
        // fires during a request still runs in that request's async context —
        // going through pino is what attaches `requestId` / `route` to the
        // failure. console.error would drop it (and skip redaction).
        logger.error({ err, event }, 'commerce-events listener threw');
      });
    });
  }
}

export const commerceEvents = new TypedEmitter();
