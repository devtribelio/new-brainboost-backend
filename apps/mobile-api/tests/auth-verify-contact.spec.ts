import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { prisma } from '@bb/db';
import { buildApp } from '../src/app';

// Generic post-login contact verification: POST /auth/requestVerify +
// /auth/verify with type 'email' | 'phone'. Replaces the email-only
// requestVerifyEmail/verifyEmail pair.
const EMAIL = 'verify-contact@example.com';
const EMAIL2 = 'verify-contact-2@example.com';
const PHONE = '81233300033';
const PHONE2 = '81233300044';
const TARGETS = [`+62${PHONE}`, `+62${PHONE2}`, EMAIL, EMAIL2];

async function cleanup() {
  await prisma.otpCode.deleteMany({ where: { target: { in: TARGETS } } });
  await prisma.notificationOutbox.deleteMany({ where: { recipient: { in: TARGETS } } });
  await prisma.member.deleteMany({
    where: { OR: [{ email: { in: [EMAIL, EMAIL2] } }, { phone: { in: [PHONE, PHONE2] } }] },
  });
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

/** Phone-register → validate OTP → login; returns access token. */
async function phoneMemberToken(app: ReturnType<typeof buildApp>): Promise<string> {
  const reg = await request(app).post('/api/member/auth/registerByPhone').send({
    phone: PHONE,
    phoneCode: '+62',
    name: 'Verify Tester',
    password: 'secret123',
  });
  await request(app).post('/api/member/auth/validateOtpPhone').send({
    memberId: String(reg.body.data.member_id),
    verifyCode: await latestCode(`+62${PHONE}`),
  });
  const login = await request(app).post('/api/member/oauth/token').send({
    grant_type: 'password',
    username: PHONE,
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

  it('phone-registered member adds an email via profile/update, then verifies it via type=email', async () => {
    const app = buildApp();
    const token = await phoneMemberToken(app);
    const auth = { Authorization: `Bearer ${token}` };

    // Add email via profile (messy form — must be stored normalized + unverified).
    const upd = await request(app)
      .post('/api/member/account/profile/update')
      .set(auth)
      .send({ email: ` ${EMAIL2.toUpperCase()} ` });
    expect(upd.status).toBe(200);
    expect(upd.body.data.email).toBe(EMAIL2);
    expect(upd.body.data.isEmailVerified).toBe(false);

    const reqRes = await request(app)
      .post('/api/member/auth/requestVerify')
      .set(auth)
      .send({ type: 'email' });
    expect(reqRes.status).toBe(200);
    expect(reqRes.body.data.target).toBe(EMAIL2);

    const verifyRes = await request(app)
      .post('/api/member/auth/verify')
      .set(auth)
      .send({ type: 'email', code: await latestCode(EMAIL2) });
    expect(verifyRes.status).toBe(200);

    const info = await request(app).get('/api/member/account/profile/info').set(auth);
    expect(info.body.data.isEmailVerified).toBe(true);
  });

  it('profile/update email is locked once verified: a verified email is silently kept', async () => {
    const app = buildApp();
    const token = await emailMemberToken(app); // email verified by register OTP
    const auth = { Authorization: `Bearer ${token}` };

    const upd = await request(app)
      .post('/api/member/account/profile/update')
      .set(auth)
      .send({ email: EMAIL2 });
    expect(upd.status).toBe(200);
    expect(upd.body.data.email).toBe(EMAIL); // unchanged
    expect(upd.body.data.isEmailVerified).toBe(true); // verification untouched
  });

  it('profile/update email can still be changed while unverified', async () => {
    const app = buildApp();
    const token = await phoneMemberToken(app);
    const auth = { Authorization: `Bearer ${token}` };

    await request(app)
      .post('/api/member/account/profile/update')
      .set(auth)
      .send({ email: EMAIL });
    // Typo'd / second thoughts before verifying — replace is allowed.
    const upd = await request(app)
      .post('/api/member/account/profile/update')
      .set(auth)
      .send({ email: EMAIL2 });
    expect(upd.status).toBe(200);
    expect(upd.body.data.email).toBe(EMAIL2);
    expect(upd.body.data.isEmailVerified).toBe(false);

    const reqRes = await request(app)
      .post('/api/member/auth/requestVerify')
      .set(auth)
      .send({ type: 'email' });
    expect(reqRes.body.data.target).toBe(EMAIL2);
  });

  it('profile/update email rejects invalid format and an email owned by another member', async () => {
    const app = buildApp();
    await emailMemberToken(app); // creates the member that owns EMAIL
    const phoneToken = await phoneMemberToken(app); // no email yet
    const auth = { Authorization: `Bearer ${phoneToken}` };

    const bad = await request(app)
      .post('/api/member/account/profile/update')
      .set(auth)
      .send({ email: 'not-an-email' });
    expect(bad.status).toBe(400);

    const taken = await request(app)
      .post('/api/member/account/profile/update')
      .set(auth)
      .send({ email: EMAIL });
    expect(taken.status).toBe(400);

    const member = await prisma.member.findFirst({ where: { phone: PHONE } });
    expect(member!.email).toBeNull();
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
