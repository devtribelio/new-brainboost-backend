import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { prisma } from '@bb/db';
import { buildApp } from '../src/app';

// Email is canonicalized (trim + lowercase) at the DTO edge — legacy register
// did strtolower; the new register path used to store mixed case, which the
// lowercasing login lookup could never find again.
const EMAIL_TYPED = '  MiXeD.Case@Example.COM ';
const EMAIL = 'mixed.case@example.com';

async function cleanup() {
  await prisma.otpCode.deleteMany({ where: { target: EMAIL } });
  await prisma.notificationOutbox.deleteMany({ where: { recipient: EMAIL } });
  await prisma.member.deleteMany({ where: { email: EMAIL } });
}

describe('email case canonicalization', () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
  });

  it('register with mixed case stores lowercase; both spellings log in', async () => {
    const app = buildApp();

    const reg = await request(app).post('/api/member/auth/register').send({
      email: EMAIL_TYPED,
      password: 'secret123',
      fullName: 'Case Tester',
    });
    expect([200, 201]).toContain(reg.status);
    expect(reg.body.data.email).toBe(EMAIL);

    const member = await prisma.member.findUnique({ where: { email: EMAIL } });
    expect(member).not.toBeNull();

    // OTP was issued against the canonical address.
    const outbox = await prisma.notificationOutbox.findFirst({
      where: { recipient: EMAIL, type: 'otp' },
      orderBy: { createdAt: 'desc' },
    });
    expect(outbox).not.toBeNull();
    await request(app).post('/api/member/auth/validateOtpEmail').send({
      memberId: String(reg.body.data.member_id),
      verifyCode: (outbox!.payload as { code: string }).code,
    });

    for (const username of [EMAIL, 'MiXeD.Case@Example.COM']) {
      const login = await request(app).post('/api/member/oauth/token').send({
        grant_type: 'password',
        username,
        password: 'secret123',
      });
      expect(login.status, `login as ${username}`).toBe(200);
    }
  });

  it('forgot password finds the member regardless of input case', async () => {
    const app = buildApp();

    const reg = await request(app).post('/api/member/auth/register').send({
      email: EMAIL,
      password: 'secret123',
      fullName: 'Case Tester',
    });
    const outbox = await prisma.notificationOutbox.findFirst({
      where: { recipient: EMAIL, type: 'otp' },
      orderBy: { createdAt: 'desc' },
    });
    await request(app).post('/api/member/auth/validateOtpEmail').send({
      memberId: String(reg.body.data.member_id),
      verifyCode: (outbox!.payload as { code: string }).code,
    });

    const res = await request(app)
      .post('/api/member/auth/requestForgotPassword')
      .send({ email: 'Mixed.CASE@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(EMAIL);
  });
});
