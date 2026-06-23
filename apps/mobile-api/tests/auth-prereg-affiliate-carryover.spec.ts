import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app';
import { prisma } from '@bb/db';

/**
 * Regression + feature coverage for the post-install affiliate flow
 * (AppsFlyer deferred deeplink → pre-registration → OTP → register).
 *
 * Covers:
 *  1. Original carry-over: PraMember.affiliateMemberId → Member.inviterId
 *     when register payload omits affiliateCode. (no regression)
 *  2. Full attribution context (programCode + UTM) → AffiliateVisit row
 *     created and bound to the new Member.id.
 *  3. affiliateCode without programCode + affiliator in exactly 1 program
 *     → visit created with that program (§3.5 fallback).
 *  4. affiliateCode without programCode + affiliator in multiple programs
 *     → no visit created, but inviterId still set.
 */
describe('auth/register: pre-registration affiliate carry-over', () => {
  const app = buildApp();
  let inviterMemberId = '';
  let inviterAffiliateCode = '';
  let affiliateProgramId = '';
  let affiliateProgramCode = '';
  let affiliateProgramId2 = '';
  let affiliateProgramCode2 = '';

  // Each test case gets its own email/phone so they can run independently.
  const ts = Date.now();
  const rnd = () => Math.floor(Math.random() * 1_000_000);

  // Test case 1 (original carry-over — no attribution context)
  const noCtxEmail = `nocontext-${ts}-${rnd()}@test.local`;
  const noCtxPhone = `0811${Math.floor(Math.random() * 100_000_000)}`;

  // Test case 2 (full context → visit created)
  const fullCtxEmail = `fullctx-${ts}-${rnd()}@test.local`;
  const fullCtxPhone = `0812${Math.floor(Math.random() * 100_000_000)}`;

  // Test case 3 (no programCode + single enrollment → auto-pick)
  const singleProgEmail = `singleprog-${ts}-${rnd()}@test.local`;
  const singleProgPhone = `0813${Math.floor(Math.random() * 100_000_000)}`;

  // Test case 4 (no programCode + multiple enrollments → skip visit)
  const multiProgEmail = `multiprog-${ts}-${rnd()}@test.local`;
  const multiProgPhone = `0814${Math.floor(Math.random() * 100_000_000)}`;

  beforeAll(async () => {
    // Create the affiliator member.
    inviterAffiliateCode = `T${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const inviter = await prisma.member.create({
      data: {
        email: `inviter-${ts}@test.local`,
        passwordHash: 'x',
        fullName: 'Inviter',
        code: inviterAffiliateCode,
        affiliateCode: inviterAffiliateCode,
      },
    });
    inviterMemberId = inviter.id;

    // Create two affiliate programs (needed by tests 2, 3, 4).
    affiliateProgramCode = `PROG${ts.toString().slice(-6)}A`;
    affiliateProgramCode2 = `PROG${ts.toString().slice(-6)}B`;

    const prog1 = await prisma.affiliateProgram.create({
      data: { code: affiliateProgramCode, name: 'Test Program A' },
    });
    affiliateProgramId = prog1.id;

    const prog2 = await prisma.affiliateProgram.create({
      data: { code: affiliateProgramCode2, name: 'Test Program B' },
    });
    affiliateProgramId2 = prog2.id;

    // Enroll inviter in program 1 (used by tests 2 + 3).
    await prisma.memberAffiliator.create({
      data: { memberId: inviterMemberId, programId: affiliateProgramId },
    });
    // Also enroll inviter in program 2 (used by test 4: multiple enrollments).
    await prisma.memberAffiliator.create({
      data: { memberId: inviterMemberId, programId: affiliateProgramId2 },
    });
  });

  afterAll(async () => {
    // Delete all newbie members created by the test cases.
    const newbieEmails = [noCtxEmail, fullCtxEmail, singleProgEmail, multiProgEmail];
    for (const email of newbieEmails) {
      const newbie = await prisma.member.findUnique({ where: { email } });
      if (newbie) {
        await prisma.affiliateVisit.deleteMany({ where: { memberId: newbie.id } });
        await prisma.refreshToken.deleteMany({ where: { memberId: newbie.id } });
        await prisma.networkMember.deleteMany({ where: { memberId: newbie.id } });
        await prisma.member.delete({ where: { id: newbie.id } });
      }
    }

    // Clean up PraMember rows that may remain if a register step failed.
    const allPhones = [noCtxPhone, fullCtxPhone, singleProgPhone, multiProgPhone];
    for (const email of newbieEmails) {
      await prisma.praMember.deleteMany({ where: { email } });
    }
    for (const phone of allPhones) {
      await prisma.praMember.deleteMany({ where: { phone } });
    }

    // Remove MemberAffiliator enrollments and AffiliatePrograms.
    await prisma.memberAffiliator.deleteMany({
      where: { memberId: inviterMemberId },
    });
    await prisma.affiliateProgram.deleteMany({
      where: { id: { in: [affiliateProgramId, affiliateProgramId2] } },
    });

    // Remove inviter.
    await prisma.refreshToken.deleteMany({ where: { memberId: inviterMemberId } });
    await prisma.member.delete({ where: { id: inviterMemberId } });

    await prisma.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // Test 1 (original carry-over — no attribution context)
  // ---------------------------------------------------------------------------

  it('carries PraMember.affiliateMemberId → Member.inviterId when register payload omits affiliateCode', async () => {
    const preReg = await request(app).post('/api/member/account/preRegistration').send({
      name: 'Newbie Carry',
      email: noCtxEmail,
      phone: noCtxPhone,
      phoneCode: '+62',
      password: 'secret123',
      confirmation: 'secret123',
      affiliateCode: inviterAffiliateCode,
      // No attribution context fields — this is the original regression test.
    });
    expect([200, 201]).toContain(preReg.status);

    const pra = await prisma.praMember.findFirst({ where: { email: noCtxEmail } });
    expect(pra?.affiliateMemberId).toBe(inviterMemberId);
    expect(pra?.attributionContext).toBeNull();

    const register = await request(app).post('/api/member/auth/register').send({
      email: noCtxEmail,
      password: 'secret123',
      fullName: 'Newbie Carry',
      phone: noCtxPhone,
      phoneCode: '+62',
      // affiliateCode: DELIBERATELY OMITTED
    });
    expect([200, 201]).toContain(register.status);

    const newbie = await prisma.member.findUnique({ where: { email: noCtxEmail } });
    expect(newbie).not.toBeNull();
    expect(newbie?.inviterId).toBe(inviterMemberId);

    // No AffiliateVisit should be created — no attributionContext was stored.
    if (newbie) {
      const visits = await prisma.affiliateVisit.findMany({ where: { memberId: newbie.id } });
      expect(visits).toHaveLength(0);
    }

    // PraMember row is consumed (existing cleanup behavior).
    const praAfter = await prisma.praMember.findFirst({ where: { email: noCtxEmail } });
    expect(praAfter).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Test 2 (full attribution context → AffiliateVisit created)
  // ---------------------------------------------------------------------------

  it('creates AffiliateVisit bound to Member.id when full attribution context is stored at pre-reg', async () => {
    const preReg = await request(app).post('/api/member/account/preRegistration').send({
      name: 'Newbie Full',
      email: fullCtxEmail,
      phone: fullCtxPhone,
      phoneCode: '+62',
      password: 'secret123',
      confirmation: 'secret123',
      affiliateCode: inviterAffiliateCode,
      programCode: affiliateProgramCode,
      utmSource: 'facebook',
      utmMedium: 'social',
      utmCampaign: 'tahun-baru-2026',
      utmContent: 'story-ad-1',
      utmTerm: 'kelas-online',
      adId: '1234567890',
      adNetwork: 'meta',
      installReferrer: 'utm_source=facebook&utm_medium=social',
      deviceId: 'abc123-device',
      platform: 'ios',
      appVersion: '1.2.3',
    });
    expect([200, 201]).toContain(preReg.status);

    const pra = await prisma.praMember.findFirst({ where: { email: fullCtxEmail } });
    expect(pra?.affiliateMemberId).toBe(inviterMemberId);
    expect(pra?.attributionContext).not.toBeNull();
    const ctx = pra?.attributionContext as Record<string, string>;
    expect(ctx.programCode).toBe(affiliateProgramCode);
    expect(ctx.utmSource).toBe('facebook');

    const register = await request(app).post('/api/member/auth/register').send({
      email: fullCtxEmail,
      password: 'secret123',
      fullName: 'Newbie Full',
      phone: fullCtxPhone,
      phoneCode: '+62',
    });
    expect([200, 201]).toContain(register.status);

    const newbie = await prisma.member.findUnique({ where: { email: fullCtxEmail } });
    expect(newbie).not.toBeNull();
    expect(newbie?.inviterId).toBe(inviterMemberId);

    // AffiliateVisit must exist and be bound to the new member.
    const visits = await prisma.affiliateVisit.findMany({
      where: { memberId: newbie!.id },
    });
    expect(visits).toHaveLength(1);
    const visit = visits[0]!;
    expect(visit.affiliatorMemberId).toBe(inviterMemberId);
    expect(visit.programId).toBe(affiliateProgramId);
    expect(visit.utmSource).toBe('facebook');
    expect(visit.utmMedium).toBe('social');
    expect(visit.utmCampaign).toBe('tahun-baru-2026');
    expect(visit.adId).toBe('1234567890');
    expect(visit.adNetwork).toBe('meta');
    expect(visit.platform).toBe('ios');
    expect(visit.appVersion).toBe('1.2.3');
  });

  // ---------------------------------------------------------------------------
  // Test 3 (affiliateCode without programCode + affiliator in exactly 1 program)
  // ---------------------------------------------------------------------------

  it('auto-picks program when affiliator is enrolled in exactly 1 program and programCode is absent', async () => {
    // For this test, we need an affiliator enrolled in only 1 program.
    // Create a separate affiliator with a single enrollment.
    const singleAffCode = `S${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const singleAff = await prisma.member.create({
      data: {
        email: `single-aff-${ts}@test.local`,
        passwordHash: 'x',
        fullName: 'Single Aff',
        code: singleAffCode,
        affiliateCode: singleAffCode,
      },
    });
    await prisma.memberAffiliator.create({
      data: { memberId: singleAff.id, programId: affiliateProgramId },
    });

    try {
      const preReg = await request(app).post('/api/member/account/preRegistration').send({
        name: 'Newbie Single',
        email: singleProgEmail,
        phone: singleProgPhone,
        phoneCode: '+62',
        password: 'secret123',
        confirmation: 'secret123',
        affiliateCode: singleAffCode,
        // No programCode — fallback to single-enrollment auto-pick.
        utmSource: 'instagram',
      });
      expect([200, 201]).toContain(preReg.status);

      const pra = await prisma.praMember.findFirst({ where: { email: singleProgEmail } });
      expect(pra?.affiliateMemberId).toBe(singleAff.id);
      const ctx = pra?.attributionContext as Record<string, string> | null;
      // programCode absent, utmSource present
      expect(ctx?.programCode).toBeUndefined();
      expect(ctx?.utmSource).toBe('instagram');

      const register = await request(app).post('/api/member/auth/register').send({
        email: singleProgEmail,
        password: 'secret123',
        fullName: 'Newbie Single',
        phone: singleProgPhone,
        phoneCode: '+62',
      });
      expect([200, 201]).toContain(register.status);

      const newbie = await prisma.member.findUnique({ where: { email: singleProgEmail } });
      expect(newbie).not.toBeNull();
      expect(newbie?.inviterId).toBe(singleAff.id);

      // Visit should be created with the auto-picked program.
      const visits = await prisma.affiliateVisit.findMany({
        where: { memberId: newbie!.id },
      });
      expect(visits).toHaveLength(1);
      expect(visits[0]!.programId).toBe(affiliateProgramId);
      expect(visits[0]!.affiliatorMemberId).toBe(singleAff.id);
      expect(visits[0]!.utmSource).toBe('instagram');
    } finally {
      // Cleanup single affiliator
      const newbie = await prisma.member.findUnique({ where: { email: singleProgEmail } });
      if (newbie) {
        await prisma.affiliateVisit.deleteMany({ where: { memberId: newbie.id } });
        await prisma.refreshToken.deleteMany({ where: { memberId: newbie.id } });
        await prisma.networkMember.deleteMany({ where: { memberId: newbie.id } });
        await prisma.member.delete({ where: { id: newbie.id } });
      }
      await prisma.memberAffiliator.deleteMany({ where: { memberId: singleAff.id } });
      await prisma.member.delete({ where: { id: singleAff.id } });
    }
  });

  // ---------------------------------------------------------------------------
  // Test 4 (affiliateCode without programCode + multiple programs → no visit)
  // ---------------------------------------------------------------------------

  it('skips visit creation (but still sets inviterId) when affiliator has multiple programs and programCode is absent', async () => {
    // inviterMemberId is enrolled in both affiliateProgramId and affiliateProgramId2
    // (set up in beforeAll), so it is the "multiple enrollments" affiliator.
    const preReg = await request(app).post('/api/member/account/preRegistration').send({
      name: 'Newbie Multi',
      email: multiProgEmail,
      phone: multiProgPhone,
      phoneCode: '+62',
      password: 'secret123',
      confirmation: 'secret123',
      affiliateCode: inviterAffiliateCode,
      // No programCode — ambiguous.
      utmSource: 'tiktok',
    });
    expect([200, 201]).toContain(preReg.status);

    const pra = await prisma.praMember.findFirst({ where: { email: multiProgEmail } });
    expect(pra?.affiliateMemberId).toBe(inviterMemberId);

    const register = await request(app).post('/api/member/auth/register').send({
      email: multiProgEmail,
      password: 'secret123',
      fullName: 'Newbie Multi',
      phone: multiProgPhone,
      phoneCode: '+62',
    });
    expect([200, 201]).toContain(register.status);

    const newbie = await prisma.member.findUnique({ where: { email: multiProgEmail } });
    expect(newbie).not.toBeNull();
    // inviterId must still be set even though visit was skipped.
    expect(newbie?.inviterId).toBe(inviterMemberId);

    // No AffiliateVisit — ambiguous program, visit was skipped.
    const visits = await prisma.affiliateVisit.findMany({
      where: { memberId: newbie!.id },
    });
    expect(visits).toHaveLength(0);
  });
});
