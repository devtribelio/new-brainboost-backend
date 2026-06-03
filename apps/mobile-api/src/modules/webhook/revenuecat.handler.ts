import { logger } from '@bb/common/config/logger';
import { env } from '@bb/common/config/env';
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

  private toPurchase(event: RevenueCatEventDto): NormalizedPurchase {
    return {
      // Key on the store transaction id so a later CANCELLATION (which carries the
      // same transaction_id, not the purchase's event id) can link back to it.
      // Fall back to the event id if the store omitted a transaction id.
      providerEventId: event.transaction_id ?? event.id,
      type: 'PURCHASE',
      memberRef: { byId: event.app_user_id, byEmail: this.emailAttr(event) },
      productRef: { bySku: event.product_id },
      // Use local currency (IDR), NOT event.price which is in USD.
      grossAmount: event.price_in_purchased_currency ?? 0,
      currency: event.currency,
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
