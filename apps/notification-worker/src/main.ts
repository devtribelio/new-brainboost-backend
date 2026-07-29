import 'dotenv/config'; // load root .env first so DATABASE_URL etc. are set before prisma
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { prisma } from '@bb/db';
import { env } from '@bb/common/config/env';
import { logger } from '@bb/common/config/logger';
import { fcmService } from '@bb/domain/notification/fcm.service';
import { handlePushMessage } from './handler';

/**
 * FCM push consumer. Long-polls the push queue, hands each body to the handler,
 * deletes on completion. Anything that THROWS is left un-deleted → SQS
 * redelivers after the visibility timeout and eventually redrives to the DLQ
 * (queue + DLQ provisioned via IaC, see docs/notification-port.md).
 *
 * Safe to scale out: work is claimed via the visibility timeout plus the
 * `push_idempotency` primary key, so N instances never double-send.
 */

const WAIT_SEC = env.sqs.pushWaitTimeSec;
const BATCH = env.sqs.pushBatchSize;
const VISIBILITY_SEC = env.sqs.pushVisibilityTimeoutSec;

let running = true;
let client: SQSClient | null = null;

function getClient(): SQSClient {
  if (client) return client;
  client = new SQSClient({
    region: env.sqs.region,
    // Local ElasticMQ only; empty in prod -> SDK uses the AWS default endpoint.
    ...(env.sqs.endpoint ? { endpoint: env.sqs.endpoint } : {}),
    // Explicit creds only for local ElasticMQ; empty in prod -> task IAM role.
    ...(env.sqs.accessKeyId && env.sqs.secretAccessKey
      ? {
          credentials: {
            accessKeyId: env.sqs.accessKeyId,
            secretAccessKey: env.sqs.secretAccessKey,
          },
        }
      : {}),
  });
  return client;
}

async function deleteMessage(message: Message): Promise<void> {
  if (!message.ReceiptHandle) return;
  await getClient().send(
    new DeleteMessageCommand({
      QueueUrl: env.sqs.pushQueueUrl,
      ReceiptHandle: message.ReceiptHandle,
    }),
  );
}

async function tick(): Promise<void> {
  const res = await getClient().send(
    new ReceiveMessageCommand({
      QueueUrl: env.sqs.pushQueueUrl,
      MaxNumberOfMessages: BATCH,
      WaitTimeSeconds: WAIT_SEC, // long poll — no busy loop
      VisibilityTimeout: VISIBILITY_SEC,
    }),
  );
  const messages = res.Messages ?? [];
  if (messages.length === 0) return;

  for (const message of messages) {
    try {
      await handlePushMessage(message.Body);
      await deleteMessage(message);
    } catch (err) {
      logger.error(
        { err, messageId: message.MessageId },
        '[push-worker] handler failed — leaving for redelivery',
      );
    }
  }
}

async function loop(): Promise<void> {
  logger.info(
    { queue: env.sqs.pushQueueUrl, batch: BATCH, waitSec: WAIT_SEC, fcm: fcmService.isEnabled() },
    '[push-worker] starting',
  );
  while (running) {
    try {
      await tick();
    } catch (err) {
      logger.error({ err }, '[push-worker] receive failed');
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, '[push-worker] shutting down');
  running = false;
  try {
    client?.destroy();
    await prisma.$disconnect();
  } catch (err) {
    logger.error({ err }, '[push-worker] shutdown error');
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

if (!env.sqs.pushQueueUrl) {
  logger.error('[push-worker] SQS_NOTIF_PUSH_URL not set — nothing to consume, exiting');
  process.exit(1);
}

loop().catch((err) => {
  logger.error({ err }, '[push-worker] fatal');
  process.exit(1);
});
