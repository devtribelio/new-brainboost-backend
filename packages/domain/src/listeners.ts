import { registerCommerceListeners } from './commerce/listeners/payment-success.listener';
import { registerNotificationListeners } from './notification/listeners/register';

/**
 * Wire all domain event listeners (commerce payment side-effects +
 * notification producers). Call exactly once per app boot, before serving
 * traffic. Idempotency is the caller's responsibility (see app bootstrap).
 */
export function registerDomainListeners(): void {
  registerCommerceListeners();
  registerNotificationListeners();
}
