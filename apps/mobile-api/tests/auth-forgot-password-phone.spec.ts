import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { prisma } from '@bb/db';
import { buildApp } from '../src/app';

// Forgot-password for phone-only members: OTP rides the WhatsApp channel
// (comms outbox), email field stays supported, email wins when both given.
const PHONE = '81277700077';
const PHONE_CODE = '+62';
const TARGET = `${PHONE_CODE}${PHONE}`;

async function cleanup() {
  await prisma.otpCode.deleteMany({ where: { target: TARGET } });
  await prisma.notificationOutbox.deleteMany({ where: { recipient: TARGET } });
  await prisma.member.deleteMany({ where: { phone: PHONE } });
}

async function latestOtpCode(): Promise<string> {
  const outbox = await prisma.notificationOutbox.findFirst({
    where: { recipient: TARGET, type: 'otp' },
    orderBy: { createdAt: 'desc' },
  });
  return (outbox!.payload as { code: string }).code;
}

/** Register + OTP-verify a phone-only member so it is active. */
async function registerActivePhoneMember(app: ReturnType<typeof buildApp>) {
  const reg = await request(app).post('/api/member/auth/registerByPhone').send({
    phone: PHONE,
    phoneCode: PHONE_CODE,
    name: 'Forgot Tester',
    password: 'oldSecret123',
  });
  await request(app)
    .post('/api/member/auth/validateOtpPhone')
    .send({ memberId: String(reg.body.data.member_id), verifyCode: await latestOtpCode() });
}

describe('forgot password via phone (phone-only member)', () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
  });

  it('resets the password with a WhatsApp OTP and the old password stops working', async () => {
    const app = buildApp();
    await registerActivePhoneMember(app);

    // Request accepts the messy national form; OTP must land on WhatsApp.
    const reqRes = await request(app)
      .post('/api/member/auth/requestForgotPassword')
      .send({ phone: `0${PHONE}` });
    expect(reqRes.status).toBe(200);
    expect(reqRes.body.data.phone).toBe(TARGET);

    const outbox = await prisma.notificationOutbox.findFirst({
      where: { recipient: TARGET, type: 'otp' },
      orderBy: { createdAt: 'desc' },
    });
    expect(outbox!.channel).toBe('whatsapp');

    // Verification with a DIFFERENT input format still hits the same target.
    const verifyRes = await request(app).post('/api/member/auth/forgotPasswordVerification').send({
      phone: `62${PHONE}`,
      code: await latestOtpCode(),
      newPassword: 'newSecret456',
    });
    expect(verifyRes.status).toBe(200);

    const oldLogin = await request(app).post('/api/member/oauth/token').send({
      grant_type: 'password',
      username: PHONE,
      password: 'oldSecret123',
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app).post('/api/member/oauth/token').send({
      grant_type: 'password',
      username: PHONE,
      password: 'newSecret456',
    });
    expect(newLogin.status).toBe(200);
  });

  it('rejects a request with neither email nor phone', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/member/auth/requestForgotPassword').send({});
    expect(res.status).toBe(400);
  });

  it('enforces the resend guard on the phone channel', async () => {
    const app = buildApp();
    await registerActivePhoneMember(app);

    const first = await request(app)
      .post('/api/member/auth/requestForgotPassword')
      .send({ phone: PHONE });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/api/member/auth/requestForgotPassword')
      .send({ phone: PHONE });
    expect(second.status).toBe(400);
  });

  it('prefers email when both fields are supplied', async () => {
    const app = buildApp();
    await registerActivePhoneMember(app);
    const email = 'forgot-tester@example.com';
    await prisma.member.update({ where: { phone: PHONE }, data: { email } });

    const res = await request(app)
      .post('/api/member/auth/requestForgotPassword')
      .send({ email, phone: PHONE });
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(email);
    expect(res.body.data.phone).toBeUndefined();

    await prisma.otpCode.deleteMany({ where: { target: email } });
    await prisma.notificationOutbox.deleteMany({ where: { recipient: email } });
  });
});
