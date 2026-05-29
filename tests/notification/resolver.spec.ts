import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { RecipientResolver } from '@/modules/notification/recipient.resolver';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

describe('RecipientResolver', () => {
  const resolver = new RecipientResolver();
  let networkId = '';
  let authorId = '';
  let memberA = '';
  let memberB = '';
  let memberDisabled = '';

  beforeAll(async () => {
    const net = await prisma.network.create({
      data: { name: `Resolver Net ${uid()}`, isPublic: true, isActive: true },
    });
    networkId = net.id;

    const author = await prisma.member.create({
      data: { email: `res-author-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
    });
    authorId = author.id;
    const a = await prisma.member.create({
      data: { email: `res-a-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
    });
    memberA = a.id;
    const b = await prisma.member.create({
      data: { email: `res-b-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
    });
    memberB = b.id;
    const d = await prisma.member.create({
      data: {
        email: `res-d-${uid()}@test.local`,
        passwordHash: await bcrypt.hash('s', 4),
        notificationsEnabled: false,
      },
    });
    memberDisabled = d.id;

    await prisma.networkMember.createMany({
      data: [
        { networkId, memberId: authorId },
        { networkId, memberId: memberA },
        { networkId, memberId: memberB },
        { networkId, memberId: memberDisabled },
      ],
    });
  });

  afterAll(async () => {
    const ids = [authorId, memberA, memberB, memberDisabled];
    await prisma.notificationMute.deleteMany({ where: { memberId: { in: ids } } });
    await prisma.networkMember.deleteMany({ where: { networkId } });
    await prisma.network.delete({ where: { id: networkId } });
    await prisma.member.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it('resolveForNetwork excludes author and disabled members', async () => {
    const ids = await resolver.resolveForNetwork(networkId, authorId);
    expect(ids).toContain(memberA);
    expect(ids).toContain(memberB);
    expect(ids).not.toContain(authorId);
    expect(ids).not.toContain(memberDisabled);
  });

  it('filterNotMuted drops members who muted the scope', async () => {
    const fakeRefId = '00000000-0000-0000-0000-000000000001';
    await prisma.notificationMute.create({
      data: { memberId: memberA, scope: 'network', refId: fakeRefId },
    });
    const ids = await resolver.filterNotMuted([memberA, memberB], [
      { scope: 'network', refId: fakeRefId },
    ]);
    expect(ids).not.toContain(memberA);
    expect(ids).toContain(memberB);
  });
});
