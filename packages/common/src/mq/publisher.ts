import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { env } from '@bb/common/config/env';
import { logger } from '@bb/common/config/logger';
import { queueNameFor } from '@bb/common/mq/topology';
import type { CommsMessage, CommsPriority } from '@bb/common/mq/comms-contract';

/**
 * Lazy-singleton SQS publisher for the comms queues. Used by the comms-relay
 * daemon to push outbox rows. One Standard queue per priority (urgent/normal) —
 * see mq/topology.ts. Local dev talks to ElasticMQ (SQS_ENDPOINT set + dummy
 * creds); prod talks to AWS SQS with `endpoint` + creds empty so the SDK resolves
 * the task IAM role. Replaces the old amqplib publisher. See docs/adr/0002.
 */
let client: SQSClient | null = null;

function getClient(): SQSClient {
  if (client) return client;
  client = new SQSClient({
    region: env.sqs.region,
    // Local ElasticMQ only; empty in prod -> SDK uses the AWS default endpoint.
    ...(env.sqs.endpoint ? { endpoint: env.sqs.endpoint } : {}),
    // Explicit creds only for local ElasticMQ; empty in prod -> SDK resolves the
    // task/instance IAM role.
    ...(env.sqs.accessKeyId && env.sqs.secretAccessKey
      ? {
          credentials: {
            accessKeyId: env.sqs.accessKeyId,
            secretAccessKey: env.sqs.secretAccessKey,
          },
        }
      : {}),
  });
  logger.info(
    { region: env.sqs.region, endpoint: env.sqs.endpoint || 'aws-default' },
    '[mq-publisher] SQS client ready',
  );
  return client;
}

/** Resolve a priority to its configured queue URL. Throws if unconfigured. */
function queueUrlFor(priority: CommsPriority): string {
  const url = priority === 'urgent' ? env.sqs.urgentQueueUrl : env.sqs.normalQueueUrl;
  if (!url) {
    throw new Error(`SQS queue URL not configured for priority=${priority} (${queueNameFor(priority)})`);
  }
  return url;
}

/** Publish one comms message. Throws on failure so the relay leaves it PENDING. */
export async function publishComms(msg: CommsMessage): Promise<void> {
  const sqs = getClient();
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrlFor(msg.priority),
      MessageBody: JSON.stringify(msg),
      // Standard queue = at-least-once; dedup/idempotency is consumer-side via
      // messageId. Surface key fields as attributes for tracing/filtering.
      MessageAttributes: {
        messageId: { DataType: 'String', StringValue: msg.messageId },
        type: { DataType: 'String', StringValue: msg.type },
      },
    }),
  );
}

export async function closePublisher(): Promise<void> {
  try {
    client?.destroy();
  } finally {
    client = null;
  }
}
