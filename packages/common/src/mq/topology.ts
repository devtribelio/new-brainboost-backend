import type { CommsPriority } from '@bb/common/mq/comms-contract';

/**
 * SQS topology — producer view. Queue NAMES are CODE CONSTANTS (not env), per
 * memory feedback_messaging_config: only connection params (region, endpoint,
 * queue URLs) live in env.
 *
 * `TOPOLOGY.queues` MUST stay byte-identical to the bb-comms consumer's
 * `internal/mq/topology.go` (`QueueUrgent`/`QueueNormal`) — bb-comms is a Go
 * repo and shares no code with this one, so these constants ARE the contract.
 * `pushQueue` is deliberately NOT part of that pair: bb-comms neither owns nor
 * consumes it.
 *
 * One Standard queue per priority. SQS has NO in-queue prioritisation, so the
 * old RabbitMQ "direct exchange + urgent/normal routing keys" maps to two
 * SEPARATE queues: urgent (OTP) gets its own queue that can't be backed up
 * behind a flood of bulk `normal` traffic. The producer resolves a queue NAME to
 * its full URL via env in mq/publisher.ts; bb-comms owns the comms queues +
 * DLQ/redrive (provisioned out-of-band via IaC).
 */
export const TOPOLOGY = {
  queues: { urgent: 'comms-urgent', normal: 'comms-normal' } as const,
  /**
   * FCM push, consumed by apps/notification-worker (this repo, NOT bb-comms).
   * Its own queue on purpose: a nightly digest fan-out must never sit in front
   * of an OTP, and a push backlog must not stall comms — the same reasoning that
   * splits urgent from normal above. DLQ + redrive provisioned via IaC.
   */
  pushQueue: 'notif-push',
} as const;

export function queueNameFor(priority: CommsPriority): string {
  return TOPOLOGY.queues[priority];
}
