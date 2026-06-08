import type { CommsPriority } from '@bb/common/mq/comms-contract';

/**
 * RabbitMQ topology — producer view. Names are CODE CONSTANTS (not env), per
 * memory feedback_messaging_config: only connection params (url, vhost) live in
 * env. MUST stay byte-identical to bb-comms `src/mq/topology.ts` — the two repos
 * share no code, so these constants are the topology contract.
 *
 * Producer only needs the exchange + routing-key mapping; bb-comms asserts the
 * queues + DLX/DLQ.
 */
export const TOPOLOGY = {
  exchange: 'comms.exchange',
  exchangeType: 'direct' as const,
  routingKeys: { urgent: 'urgent', normal: 'normal' } as const,
} as const;

export function routingKeyFor(priority: CommsPriority): string {
  return TOPOLOGY.routingKeys[priority];
}
