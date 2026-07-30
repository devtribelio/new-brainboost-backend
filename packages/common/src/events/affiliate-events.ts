import { EventEmitter } from 'node:events';
import { logger } from '@bb/common/config/logger';

export interface AffiliateCommissionCreatedEvent {
  commissionId: string;
  recipientId: string;
  paymentId: string;
  level: number;
}

export type AffiliateEventMap = {
  'affiliate.commission.created': AffiliateCommissionCreatedEvent;
};

class TypedEmitter {
  private bus = new EventEmitter();

  emit<K extends keyof AffiliateEventMap>(event: K, payload: AffiliateEventMap[K]): void {
    this.bus.emit(event, payload);
  }

  on<K extends keyof AffiliateEventMap>(
    event: K,
    listener: (payload: AffiliateEventMap[K]) => void | Promise<void>,
  ): void {
    this.bus.on(event, (payload: AffiliateEventMap[K]) => {
      Promise.resolve(listener(payload)).catch((err) => {
        // See commerce-events: `logger` (not console) is what keeps the request
        // context — emit() is synchronous, so the listener inherits it.
        logger.error({ err, event }, 'affiliate-events listener threw');
      });
    });
  }
}

export const affiliateEvents = new TypedEmitter();
