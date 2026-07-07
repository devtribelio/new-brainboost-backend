import { EventEmitter } from 'node:events';

/**
 * Subscription lifecycle events (PRD BE-07). Emitters: the commerce activation
 * listener (activated/renewed — AFTER SubscriptionService commits), the expire
 * job (expired), cancel flows (canceled). Consumers: notification listeners
 * (BE-17) and email receipts (BE-18).
 *
 * Payloads carry full identity (plan code/tier) so consumers never have to
 * query back for display data.
 */

interface SubscriptionEventBase {
  subscriptionId: string;
  ownerId: string;
  planId: string;
  planCode: string;
  tier: string;
  expiresAt: Date;
  /** 'xendit' | 'revenuecat' | 'granted' */
  source: string;
}

export interface SubscriptionActivatedEvent extends SubscriptionEventBase {
  /** Commerce transaction that paid for it; null for grants. */
  transactionId: string | null;
}

export interface SubscriptionRenewedEvent extends SubscriptionEventBase {
  transactionId: string | null;
  /** True when this "renewal" was actually an RC PRODUCT_CHANGE (tier switch). */
  planChanged: boolean;
}

export type SubscriptionExpiredEvent = SubscriptionEventBase;

export interface SubscriptionCanceledEvent extends SubscriptionEventBase {
  /** user = cancel intent (access continues); store = RC UNSUBSCRIBE; refund = immediate revoke. */
  reason: 'user' | 'store' | 'refund';
}

export type SubscriptionEventMap = {
  'subscription.activated': SubscriptionActivatedEvent;
  'subscription.renewed': SubscriptionRenewedEvent;
  'subscription.expired': SubscriptionExpiredEvent;
  'subscription.canceled': SubscriptionCanceledEvent;
};

class TypedEmitter {
  private bus = new EventEmitter();

  emit<K extends keyof SubscriptionEventMap>(event: K, payload: SubscriptionEventMap[K]): void {
    this.bus.emit(event, payload);
  }

  on<K extends keyof SubscriptionEventMap>(
    event: K,
    listener: (payload: SubscriptionEventMap[K]) => void | Promise<void>,
  ): void {
    this.bus.on(event, (payload: SubscriptionEventMap[K]) => {
      // async wrapper (not Promise.resolve(listener(...))): a SYNCHRONOUS throw in
      // the listener must also be captured, or it escapes into the EventEmitter.
      void (async () => listener(payload))().catch((err) => {
        // listeners must handle their own errors; log via parent logger if needed
        // eslint-disable-next-line no-console
        console.error(`[subscription-events] listener for ${event} threw`, err);
      });
    });
  }
}

export const subscriptionEvents = new TypedEmitter();
