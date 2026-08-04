import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { NotificationService } from '@bb/domain/notification/notification.service';
import { BadRequestException, NotFoundException } from '@bb/common/exceptions';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

function legacyId(): number {
  return 900_000_000 + Math.floor(Math.random() * 1_000_000);
}

describe('NotificationService mute scopes', () => {
  const service = new NotificationService();
  let memberId = '';
  let topicId = '';
  let topicLegacyId = 0;

  beforeAll(async () => {
    const m = await prisma.member.create({
      data: { email: `mute-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
    });
    memberId = m.id;

    topicLegacyId = legacyId();
    const topic = await prisma.topic.create({
      data: { name: `Mute Topic ${uid()}`, legacyId: topicLegacyId },
    });
    topicId = topic.id;
  });

  afterAll(async () => {
    await prisma.notificationMute.deleteMany({ where: { memberId } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.topic.delete({ where: { id: topicId } });
    await prisma.$disconnect();
  });

  it('accepts the topic scope', async () => {
    const result = await service.mute(memberId, 'topic', topicId);
    expect(result).toEqual({ scope: 'topic', refId: topicId, muted: true });

    const row = await prisma.notificationMute.findUnique({
      where: { memberId_scope_refId: { memberId, scope: 'topic', refId: topicId } },
    });
    expect(row).not.toBeNull();
  });

  it('resolves a legacyId int into the UUID ref_id', async () => {
    await service.unmute(memberId, 'topic', topicId);

    const result = await service.mute(memberId, 'topic', String(topicLegacyId));
    expect(result.refId).toBe(topicId);

    const rows = await prisma.notificationMute.findMany({ where: { memberId, scope: 'topic' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.refId).toBe(topicId);
  });

  it('unmutes by legacyId too', async () => {
    await service.mute(memberId, 'topic', topicId);
    await service.unmute(memberId, 'topic', String(topicLegacyId));

    const rows = await prisma.notificationMute.findMany({ where: { memberId, scope: 'topic' } });
    expect(rows).toHaveLength(0);
  });

  it('rejects an unknown scope on both mute and unmute', async () => {
    await expect(service.mute(memberId, 'comment', topicId)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.unmute(memberId, 'comment', topicId)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-uuid, non-legacy refId instead of surfacing a Prisma 500', async () => {
    await expect(service.mute(memberId, 'topic', 'not-a-uuid')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s when the legacyId matches nothing', async () => {
    await expect(service.mute(memberId, 'topic', String(legacyId()))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
