import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { PUSH_CONTRACT_VERSION, type PushMessage } from '@bb/common/mq/push-contract';
import { fcmService } from '@bb/domain/notification/fcm.service';

/**
 * Message handling, split from the SQS plumbing in main.ts so the rules that
 * actually matter — contract validation and at-least-once idempotency — are
 * testable without a queue.
 */

/** Parse + validate a queue body. Returns null for anything unprocessable. */
export function parsePushMessage(raw: string | undefined): PushMessage | null {
  if (!raw) return null;
  try {
    const msg = JSON.parse(raw) as PushMessage;
    if (msg.v !== PUSH_CONTRACT_VERSION) return null;
    if (!msg.messageId || !msg.memberId || !msg.title) return null;
    return msg;
  } catch {
    return null;
  }
}

/**
 * Claim a message id. Returns false when another delivery already claimed it —
 * i.e. this is an SQS redelivery and the push must NOT be sent again.
 *
 * The claim is taken BEFORE the send, not after: a duplicate push is worse than
 * a rare lost one, and the outbox row remains the record that it was queued.
 */
export async function claimMessage(messageId: string): Promise<boolean> {
  try {
    await prisma.pushIdempotency.create({ data: { messageId } });
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return false;
    throw err;
  }
}

export type HandleOutcome = 'pushed' | 'duplicate' | 'dropped';

/**
 * Process one message. Throwing means "leave it on the queue" — SQS will
 * redeliver and eventually redrive to the DLQ. Returning any outcome means the
 * message is done and the caller should delete it.
 */
export async function handlePushMessage(raw: string | undefined): Promise<HandleOutcome> {
  const msg = parsePushMessage(raw);
  if (!msg) {
    // Poison message: it can never succeed, so deleting it is better than
    // burning redrive attempts ahead of real work.
    logger.error({ raw }, '[push-worker] unparseable or unsupported message — dropping');
    return 'dropped';
  }

  if (!(await claimMessage(msg.messageId))) {
    logger.debug({ messageId: msg.messageId }, '[push-worker] duplicate delivery — skipped');
    return 'duplicate';
  }

  await fcmService.sendToMember(msg.memberId, {
    title: msg.title,
    body: msg.body,
    data: msg.data,
  });
  logger.info(
    { messageId: msg.messageId, memberId: msg.memberId, type: msg.type },
    '[push-worker] pushed',
  );
  return 'pushed';
}
