import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { env } from '@bb/common/config/env';
import { publishPush, closePublisher } from '@bb/common/mq/publisher';
import { PUSH_CHANNEL, PUSH_CONTRACT_VERSION, type PushMessage } from '@bb/common/mq/push-contract';

/**
 * Push relay daemon. Polls NotificationOutbox rows with `channel='fcm'` and
 * publishes them to the push queue; apps/notification-worker consumes and calls
 * FCM. Same outbox + same PENDING→SENT shape as workers/comms-relay.ts, but a
 * SEPARATE process and queue on purpose: the nightly digest fan-out is bursty,
 * and it must never sit in front of an OTP.
 *
 * The producer writes the outbox row in the same transaction as its domain
 * mutation, so there is no dual-write race — a published message always has a
 * committed row behind it.
 *
 * NOTE (scaling): single-instance, plain PENDING→SENT flip. To run several,
 * switch the claim to `SELECT … FOR UPDATE SKIP LOCKED`.
 */

const POLL_MS = env.sqs.relayIntervalMs;
const BATCH = env.sqs.relayBatchSize;

let running = true;
let warnedNoQueue = false;

interface OutboxRow {
  id: string;
  type: string;
  refId: string | null;
  payload: unknown;
}

/**
 * The push payload is written whole by the producer: memberId + the rendered
 * copy. `refId` carries the member id so the row is greppable without parsing
 * JSON. Returns null when the row is malformed — that is a producer bug, and
 * retrying it forever would wedge the relay.
 */
function toMessage(row: OutboxRow): PushMessage | null {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const memberId = row.refId ?? (typeof payload.memberId === 'string' ? payload.memberId : null);
  const title = typeof payload.title === 'string' ? payload.title : null;
  if (!memberId || !title) return null;

  return {
    v: PUSH_CONTRACT_VERSION,
    messageId: row.id,
    type: row.type,
    memberId,
    title,
    ...(typeof payload.body === 'string' ? { body: payload.body } : {}),
    ...(payload.data && typeof payload.data === 'object'
      ? { data: payload.data as Record<string, string> }
      : {}),
  };
}

async function tick(): Promise<void> {
  if (!env.sqs.pushQueueUrl) {
    if (!warnedNoQueue) {
      logger.warn('[push-relay] SQS_NOTIF_PUSH_URL not set — relay idle, outbox rows left PENDING');
      warnedNoQueue = true;
    }
    return;
  }

  const rows = await prisma.notificationOutbox.findMany({
    where: { status: 'PENDING', channel: PUSH_CHANNEL },
    orderBy: { scheduledAt: 'asc' },
    take: BATCH,
    select: { id: true, type: true, refId: true, payload: true },
  });
  if (rows.length === 0) return;

  let published = 0;
  for (const row of rows) {
    const msg = toMessage(row);
    if (!msg) {
      logger.error({ id: row.id, type: row.type }, '[push-relay] malformed outbox row — marking FAILED');
      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: { status: 'FAILED', lastError: 'malformed push payload', attempts: { increment: 1 } },
      });
      continue;
    }

    try {
      await publishPush(msg);
      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: { status: 'SENT', sentAt: new Date(), attempts: { increment: 1 } },
      });
      published += 1;
    } catch (err) {
      logger.error({ err, id: row.id, type: row.type }, '[push-relay] publish failed — left PENDING for retry');
      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: {
          attempts: { increment: 1 },
          lastError: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
  logger.info({ scanned: rows.length, published }, '[push-relay] published batch');
}

async function loop(): Promise<void> {
  logger.info({ pollMs: POLL_MS, batch: BATCH }, '[push-relay] starting');
  while (running) {
    try {
      await tick();
    } catch (err) {
      logger.error({ err }, '[push-relay] tick error');
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, '[push-relay] shutting down');
  running = false;
  try {
    await closePublisher();
    await prisma.$disconnect();
  } catch (err) {
    logger.error({ err }, '[push-relay] shutdown error');
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

loop().catch((err) => {
  logger.error({ err }, '[push-relay] fatal');
  process.exit(1);
});
