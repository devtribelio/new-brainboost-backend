import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@bb/db';
import { enqueueComms } from '@bb/common/services/comms-outbox';
import { CONTRACT_VERSION } from '@bb/common/mq/comms-contract';
import { routingKeyFor } from '@bb/common/mq/topology';

const TEST_RECIPIENT = '+62800000comms';

async function cleanup(): Promise<void> {
  await prisma.notificationOutbox.deleteMany({ where: { recipient: TEST_RECIPIENT } });
}

describe('enqueueComms', () => {
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('writes a PENDING outbox row with the OTP inline payload', async () => {
    const { id } = await enqueueComms({
      type: 'otp',
      channel: 'whatsapp',
      priority: 'urgent',
      recipient: TEST_RECIPIENT,
      payload: { code: '123456', name: 'Budi', ttl: 120 },
    });

    const row = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('PENDING');
    expect(row.type).toBe('otp');
    expect(row.channel).toBe('whatsapp');
    expect(row.priority).toBe('urgent');
    expect(row.recipient).toBe(TEST_RECIPIENT);
    expect(row.refId).toBeNull();
    expect((row.payload as { code: string }).code).toBe('123456');
    expect(row.attempts).toBe(0);
  });

  it('defaults priority to normal and accepts a refId (transactional type)', async () => {
    const { id } = await enqueueComms({
      type: 'CoursePaymentSuccess',
      channel: 'email',
      refId: '00000000-0000-0000-0000-000000000001',
      recipient: TEST_RECIPIENT,
    });

    const row = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id } });
    expect(row.priority).toBe('normal');
    expect(row.refId).toBe('00000000-0000-0000-0000-000000000001');
    expect(row.payload).toBeNull();
  });

  it('enrolls in the caller transaction (rolled back on failure)', async () => {
    let enqueuedId: string | undefined;
    await expect(
      prisma.$transaction(async (tx) => {
        const { id } = await enqueueComms(
          { type: 'otp', channel: 'whatsapp', recipient: TEST_RECIPIENT },
          tx,
        );
        enqueuedId = id;
        throw new Error('domain failure after enqueue');
      }),
    ).rejects.toThrow('domain failure');

    const row = await prisma.notificationOutbox.findUnique({ where: { id: enqueuedId! } });
    expect(row).toBeNull(); // rolled back with the transaction — no orphan dispatch
  });
});

describe('routingKeyFor', () => {
  it('maps priority to its queue routing key', () => {
    expect(routingKeyFor('urgent')).toBe('urgent');
    expect(routingKeyFor('normal')).toBe('normal');
  });
  it('contract version is pinned', () => {
    expect(CONTRACT_VERSION).toBe(1);
  });
});
