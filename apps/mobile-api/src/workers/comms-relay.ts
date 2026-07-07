import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { env } from '@bb/common/config/env';
import { publishComms, closePublisher } from '@bb/common/mq/publisher';
import {
  CONTRACT_VERSION,
  type CommsChannel,
  type CommsMessage,
  type CommsPriority,
} from '@bb/common/mq/comms-contract';
import { runStartupChecks, startConnectionMonitor } from '../core/startup-checks';

/**
 * Comms relay daemon (F1). Polls NotificationOutbox PENDING rows and publishes
 * them to Amazon SQS → at-least-once dispatch with no dual-write race (the
 * producer wrote the row in the same transaction as its domain mutation).
 * bb-comms consumes and delivers. See docs/adr/0002 + docs/email-scope.md §4.
 *
 * NOTE (scaling): this single-instance loop uses a plain PENDING→SENT flip. To run
 * multiple relay instances, switch the claim to `SELECT … FOR UPDATE SKIP LOCKED`.
 */

const POLL_MS = env.sqs.relayIntervalMs;
const BATCH = env.sqs.relayBatchSize;

let running = true;
let warnedNoBroker = false;

function toMessage(row: {
  id: string;
  type: string;
  channel: string;
  priority: string;
  refId: string | null;
  recipient: string | null;
  payload: unknown;
}): CommsMessage {
  return {
    v: CONTRACT_VERSION,
    messageId: row.id,
    type: row.type,
    channel: row.channel as CommsChannel,
    priority: row.priority as CommsPriority,
    ...(row.refId ? { refId: row.refId } : {}),
    ...(row.recipient ? { to: row.recipient } : {}),
    ...(row.payload ? { payload: row.payload as Record<string, unknown> } : {}),
  };
}

async function tick(): Promise<void> {
  // Dev / not-yet-provisioned: leave rows PENDING, don't spin the log.
  if (!env.sqs.urgentQueueUrl && !env.sqs.normalQueueUrl) {
    if (!warnedNoBroker) {
      logger.warn('[comms-relay] SQS queue URLs not set — relay idle, outbox rows left PENDING');
      warnedNoBroker = true;
    }
    return;
  }

  const rows = await prisma.notificationOutbox.findMany({
    where: { status: 'PENDING' },
    orderBy: { scheduledAt: 'asc' },
    take: BATCH,
  });
  if (rows.length === 0) return;

  for (const row of rows) {
    try {
      await publishComms(toMessage(row));
      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: { status: 'SENT', sentAt: new Date(), attempts: { increment: 1 } },
      });
    } catch (err) {
      logger.error({ err, id: row.id, type: row.type }, '[comms-relay] publish failed — left PENDING for retry');
      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: {
          attempts: { increment: 1 },
          lastError: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
  logger.info({ count: rows.length }, '[comms-relay] published batch');
}

async function loop(): Promise<void> {
  logger.info({ pollMs: POLL_MS, batch: BATCH }, '[comms-relay] starting');
  while (running) {
    try {
      await tick();
    } catch (err) {
      logger.error({ err }, '[comms-relay] tick error');
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, '[comms-relay] shutting down');
  running = false;
  try {
    await closePublisher();
    await prisma.$disconnect();
  } catch (err) {
    logger.error({ err }, '[comms-relay] shutdown error');
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

runStartupChecks()
  .then(() => {
    startConnectionMonitor();
    return loop();
  })
  .catch((err) => {
    logger.error({ err }, '[comms-relay] fatal');
    process.exit(1);
  });
