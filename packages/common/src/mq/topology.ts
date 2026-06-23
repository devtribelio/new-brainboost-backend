import type { CommsPriority } from '@bb/common/mq/comms-contract';

/**
 * SQS topology — producer view. Queue NAMES are CODE CONSTANTS (not env), per
 * memory feedback_messaging_config: only connection params (region, endpoint,
 * queue URLs) live in env. MUST stay byte-identical to bb-comms `src/mq/topology.ts`
 * — the two repos share no code, so these constants are the topology contract.
 *
 * One Standard queue per priority. SQS has NO in-queue prioritisation, so the
 * old RabbitMQ "direct exchange + urgent/normal routing keys" maps to two
 * SEPARATE queues: urgent (OTP) gets its own queue that can't be backed up
 * behind a flood of bulk `normal` traffic. The producer resolves a queue NAME to
 * its full URL via env in mq/publisher.ts; bb-comms owns the queues + DLQ/redrive
 * (provisioned out-of-band via IaC).
 */
export const TOPOLOGY = {
  queues: { urgent: 'comms-urgent', normal: 'comms-normal' } as const,
} as const;

export function queueNameFor(priority: CommsPriority): string {
  return TOPOLOGY.queues[priority];
}
