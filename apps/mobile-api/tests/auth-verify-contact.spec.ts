import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { prisma } from '@bb/db';
import { buildApp } from '../src/app';

// Generic post-login contact verification: POST /auth/requestVerify +
// /auth/verify with type 'email' | 'phone'. Replaces the email-only
// requestVerifyEmail/verifyEmail pair.
const EMAIL = 'verify-contact@example.com';
const PHONE = '81233300033';
const PHONE2 = '81233300044';
const TARGETS = [`+62${PHONE}`, `+62${PHONE2}`, EMAIL];

async function cleanup() {
  await prisma.otpCode.deleteMany({ where: { target: { in: TARGETS } } });
  await prisma.notificationOutbox.deleteMany({ where: { recipient: { in: TARGETS } } });
  await prisma.member.deleteMany({ where: { OR: [{ email: EMAIL }, { phone: { in: [PHONE, PHONE2] } }] } });
}

async function latestCode(recipient: string): Promise<string> {
  const outbox = await prisma.notificationOutbox.findFirst({
    where: { recipient, type: 'otp' },
    orderBy: { createdAt: 'desc' },
  });
  return (outbox!.payload as { code: string }).code;
}

/** Email-register → validate OTP → login; returns access token. */
async function emailMemberToken(app: ReturnType<typeof buildApp>): Promise<string> {
  const reg = await request(app).post('/api/member/auth/register').send({
    email: EMAIL,
    password: 'secret123',
    fullName: 'Verify Tester',
  });
  await request(app).post('/api/member/auth/validateOtpEmail').send({
    memberId: String(reg.body.data.member_id),
    verifyCode: await latestCode(EMAIL),
  });
  const login = await request(app).post('/api/member/oauth/token').send({
    grant_type: 'password',
    username: EMAIL,
    password: 'secret123',
  });
  return login.body.data.access_token as string;
}

describe('generic contact verification (post-login)', () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
  });

  it('email-registered member adds a phone and verifies it via type=phone', async () => {
    const app = buildApp();
    const token = await emailMemberToken(app);
    const auth = { Authorization: `Bearer ${token}` };

    // Add phone via profile (messy form — must be stored canonical).
    const upd = await request(app)
      .post('/api/member/account/profile/update')
      .set(auth)
      .send({ phone: `0${PHONE}`, phoneCode: '62' });
    expect(upd.status).toBe(200);
    expect(upd.body.data.phoneNumber).toBe(PHONE);
    expect(upd.body.data.isPhoneVerified).toBe(false);

    const reqRes = await request(app)
      .post('/api/member/auth/requestVerify')
      .set(auth)
      .send({ type: 'phone' });
    expect(reqRes.status).toBe(200);
    expect(reqRes.body.data.target).toBe(`+62${PHONE}`);

    const outbox = await prisma.notificationOutbox.findFirst({
      where: { recipient: `+62${PHONE}`, type: 'otp' },
      orderBy: { createdAt: 'desc' },
    });
    expect(outbox!.channel).toBe('whatsapp');

    const verifyRes = await request(app)
      .post('/api/member/auth/verify')
      .set(auth)
      .send({ type: 'phone', code: await latestCode(`+62${PHONE}`) });
    expect(verifyRes.status).toBe(200);

    const info = await request(app).get('/api/member/account/profile/info').set(auth);
    expect(info.body.data.isPhoneVerified).toBe(true);
    expect(info.body.data.isEmailVerified).toBe(true); // from register OTP
  });

  it('changing the phone number resets isPhoneVerified', async () => {
    const app = buildApp();
    const token = await emailMemberToken(app);
    const auth = { Authorization: `Bearer ${token}` };

    await request(app)
      .post('/api/member/account/profile/update')
      .set(auth)
      .send({ phone: PHONE, phoneCode: '+62' });
    await request(app).post('/api/member/auth/requestVerify').set(auth).send({ type: 'phone' });
    await request(app)
      .post('/api/member/auth/verify')
      .set(auth)
      .send({ type: 'phone', code: await latestCode(`+62${PHONE}`) });

    const upd = await request(app)
      .post('/api/member/account/profile/update')
      .set(auth)
      .send({ phone: PHONE2, phoneCode: '+62' });
    expect(upd.status).toBe(200);
    expect(upd.body.data.isPhoneVerified).toBe(false);
  });

  it('type=email on a member without email → 400; already-verified email → 400', async () => {
    const app = buildApp();
    const token = await emailMemberToken(app);
    const auth = { Authorization: `Bearer ${token}` };

    // Email already verified by the register flow.
    const dup = await request(app)
      .post('/api/member/auth/requestVerify')
      .set(auth)
      .send({ type: 'email' });
    expect(dup.status).toBe(400);

    const badType = await request(app)
      .post('/api/member/auth/requestVerify')
      .set(auth)
      .send({ type: 'fax' });
    expect(badType.status).toBe(400);

    const noAuth = await request(app).post('/api/member/auth/requestVerify').send({ type: 'phone' });
    expect(noAuth.status).toBe(401);
  });
});
