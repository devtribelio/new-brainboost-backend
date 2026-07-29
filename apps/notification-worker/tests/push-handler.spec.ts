import { describe, it, expect, afterEach, vi } from 'vitest';
import { prisma } from '@bb/db';
import { PUSH_CONTRACT_VERSION, type PushMessage } from '@bb/common/mq/push-contract';
import { fcmService } from '@bb/domain/notification/fcm.service';
import { parsePushMessage, claimMessage, handlePushMessage } from '../src/handler';

/**
 * The two rules that keep an at-least-once queue honest: reject what can never
 * be delivered, and never push the same message twice. Real Postgres for the
 * idempotency claim — that guarantee IS the unique constraint.
 */

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

function body(overrides: Partial<PushMessage> = {}): string {
  const msg: PushMessage = {
    v: PUSH_CONTRACT_VERSION,
    messageId: uid(),
    type: 'topicDigest',
    memberId: uid(),
    title: '9 post baru di Topic A',
    ...overrides,
  };
  return JSON.stringify(msg);
}

const claimed: string[] = [];

afterEach(async () => {
  if (claimed.length > 0) {
    await prisma.pushIdempotency.deleteMany({ where: { messageId: { in: claimed } } });
    claimed.length = 0;
  }
  vi.restoreAllMocks();
});

describe('parsePushMessage', () => {
  it('accepts a well-formed current-version message', () => {
    const msg = parsePushMessage(body());
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe('topicDigest');
  });

  it.each([
    ['undefined body', undefined],
    ['not json', 'nonsense{'],
    ['wrong contract version', JSON.stringify({ ...JSON.parse(body()), v: 999 })],
    ['missing memberId', JSON.stringify({ ...JSON.parse(body()), memberId: '' })],
    ['missing title', JSON.stringify({ ...JSON.parse(body()), title: '' })],
  ])('rejects %s', (_label, raw) => {
    expect(parsePushMessage(raw as string | undefined)).toBeNull();
  });
});

describe('claimMessage', () => {
  it('claims once and refuses the redelivery', async () => {
    const messageId = uid();
    claimed.push(messageId);

    expect(await claimMessage(messageId)).toBe(true);
    expect(await claimMessage(messageId)).toBe(false);
  });
});

describe('handlePushMessage', () => {
  it('pushes once, then treats the redelivery as a duplicate', async () => {
    const send = vi.spyOn(fcmService, 'sendToMember').mockResolvedValue(undefined);
    const raw = body();
    claimed.push((JSON.parse(raw) as PushMessage).messageId);

    expect(await handlePushMessage(raw)).toBe('pushed');
    expect(send).toHaveBeenCalledTimes(1);

    expect(await handlePushMessage(raw)).toBe('duplicate');
    expect(send).toHaveBeenCalledTimes(1); // not called again
  });

  it('drops a poison message without pushing', async () => {
    const send = vi.spyOn(fcmService, 'sendToMember').mockResolvedValue(undefined);

    expect(await handlePushMessage('nonsense{')).toBe('dropped');
    expect(send).not.toHaveBeenCalled();
  });

  it('propagates a send failure so SQS can redeliver', async () => {
    vi.spyOn(fcmService, 'sendToMember').mockRejectedValue(new Error('fcm down'));
    const raw = body();
    claimed.push((JSON.parse(raw) as PushMessage).messageId);

    await expect(handlePushMessage(raw)).rejects.toThrow('fcm down');
  });
});
