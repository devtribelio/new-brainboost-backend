import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { NotificationProducer } from '@bb/domain/notification/notification.producer';
import { ActionLabel } from '@bb/domain/notification/action-labels';
import { MuteScope } from '@bb/domain/notification/mute-scope';
import { fcmService } from '@bb/domain/notification/fcm.service';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function unopenedPushCount(memberId: string): Promise<number> {
  const m = await prisma.member.findUniqueOrThrow({
    where: { id: memberId },
    select: { unopenedPushCount: true },
  });
  return m.unopenedPushCount;
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
    await prisma.notificationMute.deleteMany({ where: { memberId: { in: [memberId, disabledId] } } });
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

  // Post bodies are built from `post.excerpt`, a raw slice of editor HTML, so
  // the lock screen used to read "<p>p adu</p>". Normalising in the producer is
  // what keeps a future listener from reintroducing it.
  it('stores the body as plain text when the source is editor HTML', async () => {
    const row = await producer.createForMember({
      memberId,
      type: ActionLabel.NewPost,
      title: '<b>Parker</b> memposting di Bela Diri',
      body: '<p>p adu</p><p>lawan&nbsp;&amp; kawan</p>',
      dedupeKey: `test-html-${uid()}`,
    });

    expect(row?.title).toBe('Parker memposting di Bela Diri');
    expect(row?.body).toBe('p adu lawan & kawan');
  });

  it('stores no body at all when the source was markup only', async () => {
    const row = await producer.createForMember({
      memberId,
      type: ActionLabel.NewPost,
      title: 'kosong',
      body: '<p></p><br>',
      dedupeKey: `test-html-empty-${uid()}`,
    });

    expect(row?.body).toBeNull();
  });

  // A mute takes away the push, not the record — and it must not spend the
  // member's unopened-push budget either, or muting one topic would slowly
  // silence the ones they still want.
  describe('muteScopes', () => {
    const topicRefId = '00000000-0000-0000-0000-0000000000aa';

    it('still writes the row, unread, and leaves the push budget untouched', async () => {
      await prisma.notificationMute.create({
        data: { memberId, scope: MuteScope.Topic, refId: topicRefId },
      });
      const before = await unopenedPushCount(memberId);

      const row = await producer.createForMember({
        memberId,
        type: ActionLabel.NewPost,
        title: 'muted topic',
        dedupeKey: `test-muted-${uid()}`,
        muteScopes: [{ scope: MuteScope.Topic, refId: topicRefId }],
      });
      await wait(150);

      expect(row).not.toBeNull();
      expect(row?.readAt).toBeNull();
      expect(await unopenedPushCount(memberId)).toBe(before);
    });

    it.skipIf(!fcmService.isEnabled())(
      'charges the budget when the scope is not muted',
      async () => {
        const before = await unopenedPushCount(memberId);
        await producer.createForMember({
          memberId,
          type: ActionLabel.NewPost,
          title: 'other topic',
          dedupeKey: `test-unmuted-${uid()}`,
          muteScopes: [{ scope: MuteScope.Topic, refId: '00000000-0000-0000-0000-0000000000bb' }],
        });
        await wait(150);

        expect(await unopenedPushCount(memberId)).toBe(before + 1);
      },
    );
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
