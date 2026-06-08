/**
 * Cross-repo message contract (producer side). MUST stay in sync with the
 * bb-comms repo's `src/contract/message.ts`. The two repos share no code, so
 * this is duplicated by design; bump CONTRACT_VERSION on any incompatible
 * change and only publish the new version once bb-comms supports it.
 * See docs/adr/0002.
 */

export const CONTRACT_VERSION = 1;

export type CommsChannel = 'whatsapp' | 'email' | 'sms';
export type CommsPriority = 'urgent' | 'normal';

export interface CommsMessage {
  /** Contract version. */
  v: number;
  /** Dispatch + idempotency key — the originating NotificationOutbox row id. */
  messageId: string;
  /** Template/handler discriminator: 'otp' | 'CoursePaymentSuccess' | … */
  type: string;
  channel: CommsChannel;
  priority: CommsPriority;
  /** Entity id bb-comms reads PG by (transactional types). */
  refId?: string;
  /** Direct recipient when no PG lookup (OTP). */
  to?: string;
  /** Inline data. OTP only: { code, name?, ttl? }. */
  payload?: Record<string, unknown>;
}
