import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { settingsService, SETTING_KEYS, SettingsService } from '@bb/common/services/settings.service';
import { NotificationProducer } from '@bb/domain/notification/notification.producer';
import { NotificationService } from '@bb/domain/notification/notification.service';
import { ActionLabel } from '@bb/domain/notification/action-labels';
import { MemberService } from '../../src/modules/member/member.service';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

async function setLimit(value: number) {
  await settingsService.set(SETTING_KEYS.notificationUnopenedPushLimit, String(value));
  SettingsService.clearCache();
}

async function pushCount(memberId: string): Promise<number> {
  const m = await prisma.member.findUnique({
    where: { id: memberId },
    select: { unopenedPushCount: true },
  });
  return m!.unopenedPushCount;
}

describe('unopened push limit', () => {
  const producer = new NotificationProducer();
  const notificationService = new NotificationService();
  const memberService = new MemberService();
  let memberId = '';

  beforeAll(async () => {
    const m = await prisma.member.create({
      data: { email: `push-limit-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
    });
    memberId = m.id;
  });

  beforeEach(async () => {
    await prisma.member.update({ where: { id: memberId }, data: { unopenedPushCount: 0 } });
    await setLimit(3);
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { memberId } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.appSetting.deleteMany({
      where: { key: SETTING_KEYS.notificationUnopenedPushLimit },
    });
    SettingsService.clearCache();
    await prisma.$disconnect();
  });

  it('allows the first 3 push and suppresses the 4th', async () => {
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await producer.claimPushSlot(memberId, ActionLabel.NewPost));
    }
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.count)).toEqual([1, 2, 3, 4]);
  });

  it('keeps suppressing until the member comes back', async () => {
    for (let i = 0; i < 5; i++) await producer.claimPushSlot(memberId, ActionLabel.NewPost);
    const blocked = await producer.claimPushSlot(memberId, ActionLabel.NewPost);
    expect(blocked.allowed).toBe(false);
  });

  it('re-arms when the member opens the app (/member/info touchActivity)', async () => {
    for (let i = 0; i < 4; i++) await producer.claimPushSlot(memberId, ActionLabel.NewPost);
    expect(await pushCount(memberId)).toBe(4);

    await memberService.findById(memberId, { touchActivity: true });

    expect(await pushCount(memberId)).toBe(0);
    const after = await producer.claimPushSlot(memberId, ActionLabel.NewPost);
    expect(after.allowed).toBe(true);
  });

  it('does not re-arm on a plain read without touchActivity', async () => {
    for (let i = 0; i < 4; i++) await producer.claimPushSlot(memberId, ActionLabel.NewPost);
    await memberService.findById(memberId);
    expect(await pushCount(memberId)).toBe(4);
  });

  it('re-arms after marking a notification seen', async () => {
    for (let i = 0; i < 4; i++) await producer.claimPushSlot(memberId, ActionLabel.NewPost);
    expect(await pushCount(memberId)).toBe(4);

    const row = await producer.createForMember({
      memberId,
      type: ActionLabel.NewPost,
      title: 'seen me',
      dedupeKey: `push-limit-seen-${uid()}`,
    });
    await notificationService.markSeen(memberId, { notificationId: row!.id });

    expect(await pushCount(memberId)).toBe(0);
    const after = await producer.claimPushSlot(memberId, ActionLabel.NewPost);
    expect(after.allowed).toBe(true);
  });

  it('lets transactional types through without charging the counter', async () => {
    for (let i = 0; i < 5; i++) await producer.claimPushSlot(memberId, ActionLabel.NewPost);
    const before = await pushCount(memberId);

    const payment = await producer.claimPushSlot(memberId, ActionLabel.PaymentSuccess);
    const commission = await producer.claimPushSlot(memberId, ActionLabel.CommissionEarned);

    expect(payment.allowed).toBe(true);
    expect(commission.allowed).toBe(true);
    expect(await pushCount(memberId)).toBe(before);
  });

  it('still writes the notification row when push is suppressed', async () => {
    for (let i = 0; i < 4; i++) await producer.claimPushSlot(memberId, ActionLabel.NewPost);

    const key = `push-limit-row-${uid()}`;
    const row = await producer.createForMember({
      memberId,
      type: ActionLabel.NewPost,
      title: 'masih tercatat',
      dedupeKey: key,
    });
    expect(row).not.toBeNull();

    const stored = await prisma.notification.findUnique({ where: { dedupeKey: key } });
    expect(stored).not.toBeNull();
  });

  it('never suppresses while the limit is 0, but keeps counting', async () => {
    await setLimit(0);
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await producer.claimPushSlot(memberId, ActionLabel.NewPost));
    }
    expect(results.every((r) => r.allowed)).toBe(true);
    expect(await pushCount(memberId)).toBe(5);
  });

  it('counts correctly when push land concurrently', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => producer.claimPushSlot(memberId, ActionLabel.NewPost)),
    );
    expect(await pushCount(memberId)).toBe(10);
    // Exactly one claim per slot — no two callers may see the same count.
    expect(new Set(results.map((r) => r.count)).size).toBe(10);
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
  });
});
