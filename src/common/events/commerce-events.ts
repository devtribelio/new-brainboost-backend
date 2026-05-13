import { EventEmitter } from 'node:events';

export interface CommercePaymentSuccessEvent {
  paymentId: string;
  transactionId: string;
  memberId: string;
  productId: string;
  amount: number;
  voucherAmount: number;
  voucherId?: string | null;
  affiliatorId?: string | null;
  programId?: string | null;
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
