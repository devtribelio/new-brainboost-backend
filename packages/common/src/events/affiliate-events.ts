import { EventEmitter } from 'node:events';

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
        // eslint-disable-next-line no-console
        console.error(`[affiliate-events] listener for ${event} threw`, err);
      });
    });
  }
}

export const affiliateEvents = new TypedEmitter();
