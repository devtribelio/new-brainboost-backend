import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { prisma } from '@bb/db';
import { buildApp } from '../src/app';

// Inactive-until-verified register flow:
//  - register (email or phone) creates the member isActive=false
//  - the verify-OTP step (validateOtpEmail / validateOtpPhone) activates it
//  - re-registering with the same identifier reuses the abandoned placeholder
//    row instead of erroring, as long as it never verified and is not pending
//    deletion (isReusableUnverifiedMember)
//  - password login on an unverified placeholder returns 403 ACCOUNT_NOT_VERIFIED
// OTP plaintext only exists in the comms outbox payload — tests read it there.

const PHONE = '81299900777';
const PHONE_CODE = '+62';
const TARGET = `${PHONE_CODE}${PHONE}`;
const EMAIL = 'unverified-reuse@test.local';

async function cleanup() {
  await prisma.otpCode.deleteMany({ where: { target: { in: [TARGET, EMAIL] } } });
  await prisma.notificationOutbox.deleteMany({ where: { recipient: { in: [TARGET, EMAIL] } } });
  await prisma.praMember.deleteMany({ where: { OR: [{ phone: PHONE }, { email: EMAIL }] } });
  const members = await prisma.member.findMany({
    where: { OR: [{ phone: PHONE }, { email: EMAIL }] },
    select: { id: true },
  });
  for (const m of members) {
    await prisma.refreshToken.deleteMany({ where: { memberId: m.id } });
    await prisma.networkMember.deleteMany({ where: { memberId: m.id } });
    await prisma.member.delete({ where: { id: m.id } });
  }
}

async function latestOtpCode(recipient: string): Promise<string> {
  const outbox = await prisma.notificationOutbox.findFirst({
    where: { recipient, type: 'otp' },
    orderBy: { createdAt: 'desc' },
  });
  expect(outbox).not.toBeNull();
  return (outbox!.payload as { code: string }).code;
}

describe('inactive-until-verified register flow', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  describe('phone path', () => {
    it('creates the member inactive, allows re-register on the same row, activates on OTP', async () => {
      const app = buildApp();

      const reg1 = await request(app).post('/api/member/auth/registerByPhone').send({
        phone: PHONE,
        phoneCode: PHONE_CODE,
        name: 'First Attempt',
        password: 'secret123',
      });
      expect(reg1.status).toBe(200);

      const afterFirst = await prisma.member.findUnique({ where: { phone: PHONE } });
      expect(afterFirst?.isActive).toBe(false);
      expect(afterFirst?.isPhoneVerified).toBe(false);

      // Abandoned at the OTP screen → register again with the same phone:
      // reuses the row (no "Phone already registered", no second member).
      const reg2 = await request(app).post('/api/member/auth/registerByPhone').send({
        phone: PHONE,
        phoneCode: PHONE_CODE,
        name: 'Second Attempt',
        password: 'newsecret456',
      });
      expect(reg2.status).toBe(200);

      const rows = await prisma.member.findMany({ where: { phone: PHONE } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(afterFirst!.id);
      expect(rows[0]!.fullName).toBe('Second Attempt');

      // Password login before verification is blocked (generic 401 — the
      // ACCOUNT_NOT_VERIFIED discriminator is currently disabled in
      // loginWithPassword).
      const badLogin = await request(app).post('/api/member/oauth/token').send({
        grant_type: 'password',
        username: PHONE,
        password: 'wrong-password',
      });
      expect(badLogin.status).toBe(401);

      const blockedLogin = await request(app).post('/api/member/oauth/token').send({
        grant_type: 'password',
        username: PHONE,
        password: 'newsecret456',
      });
      expect(blockedLogin.status).toBe(401);

      // Validate OTP → isPhoneVerified + isActive.
      const code = await latestOtpCode(TARGET);
      const verify = await request(app).post('/api/member/auth/validateOtpPhone').send({
        memberId: String(rows[0]!.legacyId ?? rows[0]!.id),
        verifyCode: code,
      });
      expect(verify.status).toBe(200);

      const activated = await prisma.member.findUnique({ where: { phone: PHONE } });
      expect(activated?.isPhoneVerified).toBe(true);
      expect(activated?.isActive).toBe(true);

      // Login now succeeds.
      const login = await request(app).post('/api/member/oauth/token').send({
        grant_type: 'password',
        username: PHONE,
        password: 'newsecret456',
      });
      expect(login.status).toBe(200);
      expect(login.body.data.access_token).toBeTruthy();

      // Verified row is no longer reusable.
      const reg3 = await request(app).post('/api/member/auth/registerByPhone').send({
        phone: PHONE,
        phoneCode: PHONE_CODE,
        name: 'Third Attempt',
        password: 'whatever789',
      });
      expect(reg3.status).toBe(400);
    });

    it('does not reuse a row that is pending deletion', async () => {
      const app = buildApp();

      await request(app).post('/api/member/auth/registerByPhone').send({
        phone: PHONE,
        phoneCode: PHONE_CODE,
        name: 'Deleting User',
        password: 'secret123',
      });
      await prisma.member.update({
        where: { phone: PHONE },
        data: { scheduledDeletionAt: new Date() },
      });

      const reg = await request(app).post('/api/member/auth/registerByPhone').send({
        phone: PHONE,
        phoneCode: PHONE_CODE,
        name: 'Hijacker',
        password: 'hijack123',
      });
      expect(reg.status).toBe(400);
    });

    it('does not reuse a migrated legacy row, even when inactive and unverified', async () => {
      const app = buildApp();

      // Inactive legacy member: legacy had no OTP gate, so the flags look like
      // an abandoned placeholder — legacyId must block the takeover.
      await request(app).post('/api/member/auth/registerByPhone').send({
        phone: PHONE,
        phoneCode: PHONE_CODE,
        name: 'Legacy User',
        password: 'secret123',
      });
      await prisma.member.update({
        where: { phone: PHONE },
        data: { legacyId: 99887766 },
      });

      const reg = await request(app).post('/api/member/auth/registerByPhone').send({
        phone: PHONE,
        phoneCode: PHONE_CODE,
        name: 'Hijacker',
        password: 'hijack123',
      });
      expect(reg.status).toBe(400);

      const member = await prisma.member.findUnique({ where: { phone: PHONE } });
      expect(member!.fullName).toBe('Legacy User');
    });
  });

  describe('email path', () => {
    it('creates the member inactive without tokens, reuses on re-register, activates on OTP', async () => {
      const app = buildApp();

      const reg1 = await request(app).post('/api/member/auth/register').send({
        email: EMAIL,
        password: 'secret123',
        fullName: 'Email First',
      });
      expect(reg1.status).toBe(201);
      expect(reg1.body.data.access_token).toBeUndefined();
      expect(reg1.body.data.email).toBe(EMAIL);
      expect(reg1.body.data.expired_date).toBeTruthy();

      const afterFirst = await prisma.member.findUnique({ where: { email: EMAIL } });
      expect(afterFirst?.isActive).toBe(false);
      expect(afterFirst?.isVerified).toBe(false);

      // Re-register with the same email → row reused, not duplicated.
      const reg2 = await request(app).post('/api/member/auth/register').send({
        email: EMAIL,
        password: 'newsecret456',
        fullName: 'Email Second',
      });
      expect(reg2.status).toBe(201);

      const rows = await prisma.member.findMany({ where: { email: EMAIL } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(afterFirst!.id);
      expect(rows[0]!.fullName).toBe('Email Second');

      // Resend OTP pre-login (no auth).
      const resend = await request(app).post('/api/member/auth/requestVerificationEmail').send({
        memberId: rows[0]!.id,
      });
      expect(resend.status).toBe(200);

      // Wrong code → 400.
      const wrong = await request(app).post('/api/member/auth/validateOtpEmail').send({
        memberId: rows[0]!.id,
        verifyCode: '000000',
      });
      expect(wrong.status).toBe(400);

      // Correct code → isVerified + isActive.
      const code = await latestOtpCode(EMAIL);
      const verify = await request(app).post('/api/member/auth/validateOtpEmail').send({
        memberId: rows[0]!.id,
        verifyCode: code,
      });
      expect(verify.status).toBe(200);

      const activated = await prisma.member.findUnique({ where: { email: EMAIL } });
      expect(activated?.isVerified).toBe(true);
      expect(activated?.isActive).toBe(true);

      // Login works; verified row no longer reusable.
      const login = await request(app).post('/api/member/oauth/token').send({
        grant_type: 'password',
        username: EMAIL,
        password: 'newsecret456',
      });
      expect(login.status).toBe(200);

      const reg3 = await request(app).post('/api/member/auth/register').send({
        email: EMAIL,
        password: 'whatever789',
        fullName: 'Email Third',
      });
      expect(reg3.status).toBe(400);
    });

    it('pre-registration is not blocked by a reusable unverified placeholder', async () => {
      const app = buildApp();

      await request(app).post('/api/member/auth/register').send({
        email: EMAIL,
        password: 'secret123',
        fullName: 'Email Orphan',
      });

      const prereg = await request(app).post('/api/member/account/preRegistration').send({
        name: 'Retry User',
        email: EMAIL,
        phone: PHONE,
        phoneCode: PHONE_CODE,
        password: 'secret123',
        confirmation: 'secret123',
      });
      expect(prereg.status).toBe(200);
    });
  });
});
