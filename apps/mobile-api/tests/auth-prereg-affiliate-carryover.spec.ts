import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app';
import { prisma } from '@bb/db';

/**
 * Regression coverage for the post-install affiliate flow (AppsFlyer deferred
 * deeplink → pre-registration → OTP → register).
 *
 * Mobile sends `affiliateCode` only on the pre-registration step. The register
 * step (after OTP) carries no affiliateCode in its own payload. Backend must
 * recover the inviter from `PraMember.affiliateMemberId` so post-install
 * attribution still pins `Member.inviterId` permanently.
 */
describe('auth/register: pre-registration affiliate carry-over', () => {
  const app = buildApp();
  let inviterMemberId = '';
  let inviterAffiliateCode = '';
  const newbieEmail = `newbie-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  const newbiePhone = `0811${Math.floor(Math.random() * 100_000_000)}`;

  beforeAll(async () => {
    // The affiliator (already a member, will be the inviter).
    inviterAffiliateCode = `T${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const inviter = await prisma.member.create({
      data: {
        email: `inviter-${Date.now()}@test.local`,
        passwordHash: 'x',
        fullName: 'Inviter',
        code: inviterAffiliateCode,
        affiliateCode: inviterAffiliateCode,
      },
    });
    inviterMemberId = inviter.id;
  });

  afterAll(async () => {
    const newbie = await prisma.member.findUnique({ where: { email: newbieEmail } });
    if (newbie) {
      await prisma.refreshToken.deleteMany({ where: { memberId: newbie.id } });
      await prisma.member.delete({ where: { id: newbie.id } });
    }
    await prisma.praMember.deleteMany({
      where: { OR: [{ email: newbieEmail }, { phone: newbiePhone }] },
    });
    await prisma.refreshToken.deleteMany({ where: { memberId: inviterMemberId } });
    await prisma.member.delete({ where: { id: inviterMemberId } });
    await prisma.$disconnect();
  });

  it('carries PraMember.affiliateMemberId → Member.inviterId when register payload omits affiliateCode', async () => {
    // Step 1: pre-registration carries the affiliate code (the mobile-side
    // deferred deeplink flow). PraMember row gets affiliate_member_id.
    const preReg = await request(app).post('/api/account/preRegistration').send({
      name: 'Newbie Carry',
      email: newbieEmail,
      phone: newbiePhone,
      phoneCode: '+62',
      password: 'secret123',
      confirmation: 'secret123',
      affiliateCode: inviterAffiliateCode,
    });
    expect([200, 201]).toContain(preReg.status);

    const pra = await prisma.praMember.findFirst({ where: { email: newbieEmail } });
    expect(pra?.affiliateMemberId).toBe(inviterMemberId);

    // Step 2: register WITHOUT affiliateCode in the payload — mimics current
    // mobile behavior where the code lives only in the pre-reg model.
    const register = await request(app).post('/api/member/auth/register').send({
      email: newbieEmail,
      password: 'secret123',
      fullName: 'Newbie Carry',
      phone: newbiePhone,
      phoneCode: '+62',
      // affiliateCode: DELIBERATELY OMITTED
    });
    expect([200, 201]).toContain(register.status);

    const newbie = await prisma.member.findUnique({ where: { email: newbieEmail } });
    expect(newbie).not.toBeNull();
    // The fix: inviterId is recovered from PraMember even though the register
    // payload didn't carry the affiliate code.
    expect(newbie?.inviterId).toBe(inviterMemberId);

    // PraMember row is consumed (existing cleanup behavior).
    const praAfter = await prisma.praMember.findFirst({ where: { email: newbieEmail } });
    expect(praAfter).toBeNull();
  });
});
