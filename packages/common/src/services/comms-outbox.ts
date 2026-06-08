import { prisma } from '@bb/db';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { CommsChannel, CommsPriority } from '@bb/common/mq/comms-contract';

export interface EnqueueCommsInput {
  /** Template/handler discriminator: 'otp' | 'CoursePaymentSuccess' | … */
  type: string;
  channel: CommsChannel;
  /** Defaults to 'normal'. Use 'urgent' for OTP / payment / disbursement. */
  priority?: CommsPriority;
  /** Entity id bb-comms reads PG by (transactional types). */
  refId?: string;
  /** Direct recipient when no PG lookup (OTP: phone/email). */
  recipient?: string;
  /** Inline data. OTP only: { code, name?, ttl? } — otp_codes holds only the hash. */
  payload?: Prisma.InputJsonValue;
}

/**
 * Minimal Prisma surface the helper needs — satisfied by the client OR a
 * transaction client, so callers can enqueue inside their domain transaction
 * (no dual-write race). See docs/adr/0002 + docs/email-scope.md §4.
 */
type OutboxWriter = Pick<PrismaClient, 'notificationOutbox'> | Prisma.TransactionClient;

/**
 * Write one outbound message to the transactional outbox. The comms-relay daemon
 * publishes PENDING rows to RabbitMQ; bb-comms delivers. The returned row id is
 * the message id used downstream for idempotency.
 *
 * Pass a transaction client (`tx`) to atomically enqueue alongside a domain
 * mutation:
 *   await prisma.$transaction(async (tx) => {
 *     const order = await tx.commerceTransaction.create(...);
 *     await enqueueComms({ type: 'CoursePaymentSuccess', channel: 'email', refId: order.id }, tx);
 *   });
 */
export async function enqueueComms(
  input: EnqueueCommsInput,
  tx: OutboxWriter = prisma,
): Promise<{ id: string }> {
  const row = await tx.notificationOutbox.create({
    data: {
      type: input.type,
      channel: input.channel,
      priority: input.priority ?? 'normal',
      refId: input.refId ?? null,
      recipient: input.recipient ?? null,
      payload: input.payload ?? undefined,
    },
    select: { id: true },
  });
  return row;
}
