import { logger } from '@bb/common/config/logger';
import { env } from '@bb/common/config/env';
import { isUuid } from '@bb/common/utils/uuid.util';
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
  async handle(event: RevenueCatEventDto): Promise<RevenueCatHandleResult> {
    // Full event logged on entry — gives a forensic trail for fee/encoding
    // surprises like the takehome_percentage discovery, without depending on
    // any single field surviving DTO whitelist. App log retention is short;
    // for long-term audit see `commerce_payments.log_request` (persisted in
    // the ingest service on successful purchase).
    logger.info({ event }, '[revenuecat] webhook received');

    const isPurchase = PURCHASE_EVENT_TYPES.has(event.type);
    const isRefund = REFUND_EVENT_TYPES.has(event.type);

    if (!isPurchase && !isRefund) {
      logger.info({ eventType: event.type, eventId: event.id }, '[revenuecat] skipped event');
      return { handled: false, status: 'skipped' };
    }

    // Sandbox events are ingested like any other. Refusing them in production was tried
    // and reverted: App Review runs its purchases in the SANDBOX environment against the
    // PRODUCTION app, so dropping them leaves the reviewer with no CourseEnrollment and
    // `isPurchased: false` — a purchase that visibly does nothing, i.e. a rejection.
    // `environment` is still carried on the DTO so sandbox rows stay identifiable in
    // `commerce_payments.log_request` after the fact.
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
    // member_not_found means a real purchase got no access — surface it at warn
    // so it is alertable, since the response is still a 200 (RC must not retry).
    const level = result.status === 'member_not_found' ? 'warn' : 'info';
    logger[level](
      {
        eventType: event.type,
        eventId: event.id,
        status: result.status,
        appUserId: event.app_user_id,
        memberRef: normalized.memberRef,
      },
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

  private toPurchase(event: RevenueCatEventDto): NormalizedPurchase {
    const gross = event.price_in_purchased_currency ?? 0;
    const occurredAt = event.event_timestamp_ms
      ? new Date(event.event_timestamp_ms).toISOString()
      : undefined;
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
      memberRef: this.memberRef(event),
      productRef: { bySku: event.product_id },
      // Affiliate attribution is VISIT-driven (B-3): the customer-global RC
      // `affiliate_code` subscriber attribute is sticky (never expires) and would
      // ride along onto unrelated later purchases, so it is intentionally NOT
      // read here. Attribution resolves from the self-expiring, last-touch
      // `AffiliateVisit` (logged by the app on the affiliate link), scoped to the
      // purchased product (B-5: ingest passes productId) → buyer inviter.
      affiliatorCode: undefined,
      // `grossAmount` is in `currency`, NOT necessarily IDR: `price_in_purchased_currency`
      // follows the buyer's storefront, so an AU purchase arrives as 39.99 (AUD). Ingest
      // normalises to IDR using `amountUsd` — passing the local figure through untouched
      // is what recorded A$39.99 as Rp40 and paid a Rp5 commission on it.
      grossAmount: gross,
      netAmount: computeNetAmount(
        gross,
        event.takehome_percentage,
        event.commission_percentage,
        event.tax_percentage,
      ),
      currency: event.currency,
      // RevenueCat's own USD conversion of the same purchase — the single bridge that
      // lets one USD/IDR rate serve every storefront.
      amountUsd: event.price,
      isRenewal: event.type === 'RENEWAL',
      occurredAt,
      raw: event,
    };
  }

  private toRefund(event: RevenueCatEventDto): NormalizedPurchase {
    return {
      providerEventId: event.id, // the refund event's own id
      type: 'REFUND',
      memberRef: this.memberRef(event),
      productRef: { bySku: event.product_id },
      grossAmount: 0,
      // The refunded purchase was keyed on its transaction_id.
      refundOfProviderEventId: event.transaction_id ?? event.original_transaction_id,
      raw: event,
    };
  }

  /**
   * Resolve who bought. `app_user_id` is only a `Member.id` once the app has
   * called `Purchases.logIn()` — a purchase completed before that (or after a
   * reinstall/logout) arrives as `$RCAnonymousID:<hex>`, and RC only ever puts
   * the real id in `aliases` if the SDK aliased it later. So:
   *
   *   1. first UUID among app_user_id → original_app_user_id → aliases
   *   2. else the `$email` subscriber attribute (set by the app at login)
   *
   * Both go into `memberRef`; ingest tries id then email. Anonymous ids are
   * dropped rather than passed through — `members.id` is `@db.Uuid`, so sending
   * one to Prisma throws P2023 (500 → RC retries forever) instead of missing.
   */
  private memberRef(event: RevenueCatEventDto): { byId?: string; byEmail?: string } {
    const byId = [event.app_user_id, event.original_app_user_id, ...(event.aliases ?? [])].find(
      (candidate) => isUuid(candidate),
    );
    const byEmail = this.emailAttr(event);

    if (!byId) {
      logger.warn(
        { eventId: event.id, appUserId: event.app_user_id, hasEmail: Boolean(byEmail) },
        '[revenuecat] app_user_id is not a member UUID — falling back to $email',
      );
    }
    return { byId, byEmail };
  }

  /** Best-effort email from RC subscriber attributes (`$email`). */
  private emailAttr(event: RevenueCatEventDto): string | undefined {
    return event.subscriber_attributes?.['$email']?.value?.trim() || undefined;
  }
}
