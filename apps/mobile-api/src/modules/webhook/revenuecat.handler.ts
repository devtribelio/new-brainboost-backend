import { logger } from '@bb/common/config/logger';
import { env } from '@bb/common/config/env';
import { subscriptionEvents } from '@bb/common/events/subscription-events';
import { SubscriptionService } from '@bb/domain/subscription/subscription.service';
import {
  purchaseIngestService,
  type NormalizedPurchase,
} from '../ingest/purchase-ingest.service';
import { credentialService } from '../ingest/credential.service';
import type { RevenueCatEventDto } from './dto/revenuecat-callback.dto';

/** RC event types we treat as a purchase (grant access). All map to ingest PURCHASE. */
const PURCHASE_EVENT_TYPES = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'NON_RENEWING_PURCHASE',
  'PRODUCT_CHANGE',
]);

/** RC event types we treat as a refund (revoke access + void commission). */
const REFUND_EVENT_TYPES = new Set(['CANCELLATION']);

/**
 * CANCELLATION reasons that mean "auto-renew off, access continues" (cancel
 * intent) rather than a refund. Anything else — CUSTOMER_SUPPORT (real refund),
 * absent (legacy payloads, retail consumables), unknown — takes the refund path,
 * preserving pre-subscription behavior exactly.
 */
const CANCEL_INTENT_REASONS = new Set(['UNSUBSCRIBE', 'BILLING_ERROR']);

/**
 * Compute the net amount Brainboost takes home from a RC purchase event.
 *
 * **Source of truth: `takehome_percentage`** — RC precomputes this and it
 * already accounts for commission, regional tax handling (e.g. tax-inclusive
 * IDR pricing where consumer pays the PPN, not the developer), and currency
 * conversion. Confirmed against a real ID sandbox event:
 *   `gross=429000, takehome=0.7, commission=0.2703, tax=0.0991`
 * RC's takehome (0.7 → net 300_300) ≠ multiplicative `(1-c)(1-t)` (→ net
 * 282_018) because tax in ID is consumer-paid, not deducted from dev share.
 *
 * Fallback to multiplicative `(1-c)(1-t)` is only used when `takehome` is
 * absent — older RC payloads or partial events. Returns `undefined` when
 * nothing is available so `acceptedAmount` falls back to `gross` cleanly.
 */
export function computeNetAmount(
  gross: number,
  takehomePct?: number,
  commissionPct?: number,
  taxPct?: number,
): number | undefined {
  if (takehomePct != null) {
    const h = Math.max(0, Math.min(1, takehomePct));
    return Math.floor(gross * h);
  }
  if (commissionPct == null && taxPct == null) return undefined;
  const c = Math.max(0, Math.min(1, commissionPct ?? 0));
  const t = Math.max(0, Math.min(1, taxPct ?? 0));
  return Math.floor(gross * (1 - c) * (1 - t));
}

export interface RevenueCatHandleResult {
  handled: boolean;
  /** ingest outcome when handled, or the skip/error reason when not. */
  status: string;
  transactionId?: string;
  paymentId?: string;
  voidedCommissions?: number;
}

/**
 * RevenueCat webhook → ingest kernel adapter. Replaces the standalone Supabase
 * edge function: instead of forwarding to legacy Tribeversity over HTTP, it maps
 * the RC event to a provider-agnostic `NormalizedPurchase` and feeds the same
 * `purchaseIngestService` the web/Xendit and other channels use. The success
 * path grants `CourseEnrollment` (→ `isPurchased: true`); the refund path
 * revokes it.
 *
 * Auth is handled upstream by `revenueCatCallbackGuard` (shared-secret header),
 * so here we load the `revenuecat` ThirdPartyCredential by name purely for its
 * per-channel toggles (`triggersAffiliate` / `canIngestRefund`).
 */
export class RevenueCatWebhookHandler {
  constructor(private readonly subscriptionService = new SubscriptionService()) {}

  async handle(event: RevenueCatEventDto): Promise<RevenueCatHandleResult> {
    // Full event logged on entry — gives a forensic trail for fee/encoding
    // surprises like the takehome_percentage discovery, without depending on
    // any single field surviving DTO whitelist. App log retention is short;
    // for long-term audit see `commerce_payments.log_request` (persisted in
    // the ingest service on successful purchase).
    logger.info({ event }, '[revenuecat] webhook received');

    // Subscription lifecycle events that never touch the ingest kernel (BE-12):
    // EXPIRATION ends the sub; CANCELLATION with UNSUBSCRIBE/BILLING_ERROR is a
    // cancel-INTENT (access continues). Both key on original_transaction_id.
    if (event.type === 'EXPIRATION') {
      return this.handleExpiration(event);
    }
    if (
      event.type === 'CANCELLATION' &&
      event.cancel_reason != null &&
      CANCEL_INTENT_REASONS.has(event.cancel_reason)
    ) {
      return this.handleCancelIntent(event);
    }

    const isPurchase = PURCHASE_EVENT_TYPES.has(event.type);
    const isRefund = REFUND_EVENT_TYPES.has(event.type);

    if (!isPurchase && !isRefund) {
      logger.info({ eventType: event.type, eventId: event.id }, '[revenuecat] skipped event');
      return { handled: false, status: 'skipped' };
    }

    const cred = await credentialService.verifyByName(env.revenuecat.providerName);
    if (!cred) {
      // Misconfiguration: the credential row is missing/inactive. Log loudly and
      // return 200 so RC stops retrying (a retry can't fix a missing credential).
      logger.error(
        { providerName: env.revenuecat.providerName, eventId: event.id },
        '[revenuecat] no active credential — purchase NOT ingested',
      );
      return { handled: false, status: 'credential_not_configured' };
    }

    const normalized = isPurchase
      ? this.toPurchase(event)
      : this.toRefund(event);

    const result = await purchaseIngestService.ingest(normalized, cred);
    logger.info(
      { eventType: event.type, eventId: event.id, status: result.status },
      '[revenuecat] ingested',
    );
    return {
      handled: true,
      status: result.status,
      transactionId: result.transactionId,
      paymentId: result.paymentId,
      voidedCommissions: result.voidedCommissions,
    };
  }

  private async handleExpiration(event: RevenueCatEventDto): Promise<RevenueCatHandleResult> {
    const providerRef = event.original_transaction_id ?? event.transaction_id;
    if (!providerRef) {
      logger.warn({ eventId: event.id }, '[revenuecat] EXPIRATION without transaction ref — skipped');
      return { handled: false, status: 'skipped' };
    }
    const sub = await this.subscriptionService.expireByProviderRef(providerRef);
    if (!sub) {
      logger.info({ providerRef, eventId: event.id }, '[revenuecat] EXPIRATION: no active sub — noop');
      return { handled: true, status: 'expiration_noop' };
    }
    subscriptionEvents.emit('subscription.expired', {
      subscriptionId: sub.id,
      ownerId: sub.ownerId,
      planId: sub.plan.id,
      planCode: sub.plan.code,
      tier: sub.plan.tier,
      expiresAt: sub.expiresAt,
      source: sub.source,
    });
    logger.info({ subscriptionId: sub.id, providerRef }, '[revenuecat] subscription expired');
    return { handled: true, status: 'expired' };
  }

  private async handleCancelIntent(event: RevenueCatEventDto): Promise<RevenueCatHandleResult> {
    const providerRef = event.original_transaction_id ?? event.transaction_id;
    if (!providerRef) {
      logger.warn({ eventId: event.id }, '[revenuecat] CANCELLATION without transaction ref — skipped');
      return { handled: false, status: 'skipped' };
    }
    const sub = await this.subscriptionService.cancelIntentByProviderRef(providerRef);
    if (!sub) {
      // Not a sub / already intent / not active — nothing to do (idempotent).
      return { handled: true, status: 'cancel_intent_noop' };
    }
    subscriptionEvents.emit('subscription.canceled', {
      subscriptionId: sub.id,
      ownerId: sub.ownerId,
      planId: sub.plan.id,
      planCode: sub.plan.code,
      tier: sub.plan.tier,
      expiresAt: sub.expiresAt,
      source: sub.source,
      reason: 'store',
    });
    logger.info(
      { subscriptionId: sub.id, providerRef, cancelReason: event.cancel_reason },
      '[revenuecat] cancel intent recorded — access continues to expiry',
    );
    return { handled: true, status: 'cancel_intent' };
  }

  private toPurchase(event: RevenueCatEventDto): NormalizedPurchase {
    const gross = event.price_in_purchased_currency ?? 0;
    return {
      // Key on the store transaction id so a later CANCELLATION (which carries the
      // same transaction_id, not the purchase's event id) can link back to it.
      // Fall back to the event id if the store omitted a transaction id.
      providerEventId: event.transaction_id ?? event.id,
      // Commission idempotency key (B-2): Apple's `original_transaction_id` is
      // STABLE across delete+rebuy / renewal / restore / re-sync (a non-consumable
      // is permanently owned), whereas `transaction_id` changes. Ingest claims
      // commission once per (provider, attributionKey) so re-settles never
      // double-pay. Falls back to the event/txn id when absent.
      attributionKey: event.original_transaction_id ?? event.transaction_id ?? event.id,
      type: 'PURCHASE',
      memberRef: { byId: event.app_user_id, byEmail: this.emailAttr(event) },
      productRef: { bySku: event.product_id },
      // Affiliate attribution is VISIT-driven (B-3): the customer-global RC
      // `affiliate_code` subscriber attribute is sticky (never expires) and would
      // ride along onto unrelated later purchases, so it is intentionally NOT
      // read here. Attribution resolves from the self-expiring, last-touch
      // `AffiliateVisit` (logged by the app on the affiliate link), scoped to the
      // purchased product (B-5: ingest passes productId) → buyer inviter.
      affiliatorCode: undefined,
      // Use local currency (IDR), NOT event.price which is in USD.
      grossAmount: gross,
      netAmount: computeNetAmount(
        gross,
        event.takehome_percentage,
        event.commission_percentage,
        event.tax_percentage,
      ),
      currency: event.currency,
      isRenewal: event.type === 'RENEWAL',
      // Subscription facts (BE-13): bind the sub to the store subscription and
      // carry RC's authoritative expiry. Harmless for consumables (no plan → the
      // activation listener no-ops).
      subscription: {
        providerRef: event.original_transaction_id ?? event.transaction_id ?? null,
        expirationAtMs: event.expiration_at_ms ?? null,
      },
      occurredAt: undefined,
      raw: event,
    };
  }

  private toRefund(event: RevenueCatEventDto): NormalizedPurchase {
    return {
      providerEventId: event.id, // the refund event's own id
      type: 'REFUND',
      memberRef: { byId: event.app_user_id, byEmail: this.emailAttr(event) },
      productRef: { bySku: event.product_id },
      grossAmount: 0,
      // The refunded purchase was keyed on its transaction_id.
      refundOfProviderEventId: event.transaction_id ?? event.original_transaction_id,
      raw: event,
    };
  }

  /** Best-effort email from RC subscriber attributes (`$email`). */
  private emailAttr(event: RevenueCatEventDto): string | undefined {
    return event.subscriber_attributes?.['$email']?.value || undefined;
  }
}
