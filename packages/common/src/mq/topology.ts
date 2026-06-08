import { env } from '@bb/common/config/env';
import type { CommsPriority } from '@bb/common/mq/comms-contract';

/**
 * RabbitMQ topology — producer view. Mirror of bb-comms `src/mq/topology.ts`
 * (one exchange, two priority queues bound by routing key). The producer only
 * needs the exchange + routing-key mapping; bb-comms asserts queues + DLX.
 */
export const TOPOLOGY = {
  exchange: env.rabbitmq.exchange,
  exchangeType: 'direct' as const,
  routingKeys: { urgent: 'urgent', normal: 'normal' } as const,
} as const;

export function routingKeyFor(priority: CommsPriority): string {
  return TOPOLOGY.routingKeys[priority];
}
