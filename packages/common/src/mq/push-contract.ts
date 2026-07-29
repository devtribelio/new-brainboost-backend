/**
 * FCM push message contract.
 *
 * Unlike `comms-contract.ts`, both ends of this one live in THIS repo
 * (producer: the outbox relay; consumer: apps/notification-worker), so it is not
 * a cross-repo duplication — but it is still a wire format: a message published
 * before a deploy is consumed after it. Bump PUSH_CONTRACT_VERSION on any
 * incompatible change and teach the worker the new version before publishing it.
 */

export const PUSH_CONTRACT_VERSION = 1;

/** Outbox `channel` value that routes a row to the push queue instead of comms. */
export const PUSH_CHANNEL = 'fcm';

/**
 * Outbox `channel` values that belong to bb-comms. Mirrors that repo's
 * `contract.Channel` (internal/contract/message.go) — it errors on anything else,
 * which means an `fcm` row reaching a comms queue would NOT be deleted, would be
 * redelivered until maxReceiveCount, and would land in the comms DLQ. That is why
 * workers/comms-relay.ts scopes its query to this list.
 */
export const COMMS_CHANNELS = ['whatsapp', 'email', 'sms'] as const;

export interface PushMessage {
  /** Contract version. */
  v: number;
  /** Dispatch + idempotency key — the originating NotificationOutbox row id. */
  messageId: string;
  /** Handler discriminator, e.g. 'topicDigest'. */
  type: string;
  /** Who to push to; the worker resolves their device tokens. */
  memberId: string;
  title: string;
  body?: string;
  /** FCM `data` block. Values must already be strings. */
  data?: Record<string, string>;
}
