import { EventEmitter } from 'node:events';

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
   * instead of `paymentSuccess` when true. Feeds renewal-rate detection (BE-09).
   */
  isRenewal?: boolean;
  /**
   * Provider subscription facts (BE-13, RC only): providerRef = the store's
   * original_transaction_id (binds the sub for later EXPIRATION/CANCELLATION
   * lookups), expiresAt = authoritative entitlement expiry from the provider.
   * Channels without a subscription concept leave this undefined.
   */
  subscription?: { providerRef?: string | null; expiresAt?: Date | null };
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
        // listeners must handle their own errors; log via parent logger if needed
        // eslint-disable-next-line no-console
        console.error(`[commerce-events] listener for ${event} threw`, err);
      });
    });
  }
}

export const commerceEvents = new TypedEmitter();
