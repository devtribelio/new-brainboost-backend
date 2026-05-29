import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { NotificationProducer } from '@bb/domain/notification/notification.producer';
import { ActionLabel } from '@bb/domain/notification/action-labels';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

describe('NotificationProducer', () => {
  const producer = new NotificationProducer();
  let memberId = '';
  let disabledId = '';

  beforeAll(async () => {
    const a = await prisma.member.create({
      data: { email: `prod-a-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
    });
    memberId = a.id;
    const b = await prisma.member.create({
      data: {
        email: `prod-b-${uid()}@test.local`,
        passwordHash: await bcrypt.hash('s', 4),
        notificationsEnabled: false,
      },
    });
    disabledId = b.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { memberId: { in: [memberId, disabledId] } } });
    await prisma.member.deleteMany({ where: { id: { in: [memberId, disabledId] } } });
    await prisma.$disconnect();
  });

  it('creates a notification row for an enabled member', async () => {
    const row = await producer.createForMember({
      memberId,
      type: ActionLabel.NewLike,
      title: 'liked',
      dedupeKey: `test-create-${uid()}`,
    });
    expect(row).not.toBeNull();
    expect(row?.memberId).toBe(memberId);
    expect(row?.type).toBe('newLike');
  });

  it('dedupes: same dedupeKey returns null on second call', async () => {
    const key = `test-dedupe-${uid()}`;
    const first = await producer.createForMember({
      memberId,
      type: ActionLabel.NewComment,
      title: 'first',
      dedupeKey: key,
    });
    const second = await producer.createForMember({
      memberId,
      type: ActionLabel.NewComment,
      title: 'second',
      dedupeKey: key,
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    const rows = await prisma.notification.findMany({ where: { dedupeKey: key } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('first');
  });

  it('skips when member has notificationsEnabled=false', async () => {
    const row = await producer.createForMember({
      memberId: disabledId,
      type: ActionLabel.NewPost,
      title: 'no notif',
      dedupeKey: `test-disabled-${uid()}`,
    });
    expect(row).toBeNull();
    const rows = await prisma.notification.findMany({ where: { memberId: disabledId } });
    expect(rows).toHaveLength(0);
  });
});
