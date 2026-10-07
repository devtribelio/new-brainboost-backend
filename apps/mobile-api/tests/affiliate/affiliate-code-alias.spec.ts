/**
 * A legacy dedup loser's affiliate code (member_affiliate_code_aliases) must resolve
 * to the winner it was merged into, at every code-to-member lookup.
 *
 * Requires a reachable Postgres test DB (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { AttributionService } from '@bb/domain/affiliate/attribution.service';
import { VisitService } from '@bb/domain/affiliate/visit.service';
import { ERROR_CODES } from '@bb/common/exceptions';
import { AccountService } from '../../src/modules/account/account.service';

const TAG = `code-alias-${Date.now()}`;
const code = (len = 8) => randomUUID().replace(/-/g, '').slice(0, len).toUpperCase();

describe('affiliate code alias', () => {
  const memberIds: string[] = [];
  const aliasCode = code();
  let winnerId = '';

  async function mkMember(): Promise<string> {
    const m = await prisma.member.create({
      data: { email: `${TAG}-${randomUUID()}@t.local`, passwordHash: await bcrypt.hash('x', 4), affiliateCode: code(6) },
      select: { id: true },
    });
    memberIds.push(m.id);
    return m.id;
  }

  beforeAll(async () => {
    winnerId = await mkMember();
    await prisma.memberAffiliateCodeAlias.create({
      data: { code: aliasCode, memberId: winnerId, source: 'LEGACY_DEDUP' },
    });
  });

  afterAll(async () => {
    if (memberIds.length) {
      await prisma.affiliateVisit.deleteMany({ where: { affiliatorMemberId: { in: memberIds } } });
      await prisma.member.deleteMany({ where: { id: { in: memberIds } } }); // cascades the alias
    }
    await prisma.$disconnect();
  });

  it('checkout explicit code: the alias attributes to the winner', async () => {
    const buyer = await mkMember();
    expect(await new AttributionService().resolveOverrideAffiliatorMemberId(buyer, aliasCode)).toBe(winnerId);
  });

  it('visit logging: an alias click is stored against the winner', async () => {
    const res = await new VisitService().logVisit({ affiliatorCode: aliasCode });
    expect(res.status).toBe('logged');
    expect(await prisma.affiliateVisit.count({ where: { affiliatorMemberId: winnerId } })).toBe(1);
  });

  it('affiliateConnect: an alias code binds the winner as inviter', async () => {
    const me = await mkMember();
    const res = await new AccountService().affiliateConnect(me, aliasCode);
    expect(res.alreadyConnected).toBe(false);
    expect((await prisma.member.findUnique({ where: { id: me } }))?.inviterId).toBe(winnerId);
  });

  it('affiliateConnect: the winner connecting to their own alias is a self-connect', async () => {
    await expect(new AccountService().affiliateConnect(winnerId, aliasCode)).rejects.toMatchObject({
      code: ERROR_CODES.AFFILIATE_SELF_CONNECT,
    });
  });
});
