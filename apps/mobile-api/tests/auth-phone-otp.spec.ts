import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { prisma } from '@bb/db';
import { buildApp } from '../src/app';

// Phone-register issues a WhatsApp OTP. Post-F3 the dispatch is decoupled: the
// otp row + a comms outbox row are written in one transaction, and the
// comms-relay → bb-comms pipeline delivers it. The plaintext code never leaves
// the backend except inline in the outbox payload (otp_codes holds only the
// hash), so the test reads it from there.
const PHONE = '81299900099';
const PHONE_CODE = '+62';
const TARGET = `${PHONE_CODE}${PHONE}`;

async function cleanup() {
  await prisma.otpCode.deleteMany({ where: { target: TARGET } });
  await prisma.notificationOutbox.deleteMany({ where: { recipient: TARGET } });
  await prisma.member.deleteMany({ where: { phone: PHONE } });
}

async function latestOtpOutbox() {
  return prisma.notificationOutbox.findFirst({
    where: { recipient: TARGET, type: 'otp' },
    orderBy: { createdAt: 'desc' },
  });
}

describe('phone OTP flow (register → verify)', () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
  });

  it('registers by phone, enqueues a WhatsApp OTP, then verifies with it', async () => {
    const app = buildApp();

    const reg = await request(app).post('/api/member/auth/registerByPhone').send({
      phone: PHONE,
      phoneCode: PHONE_CODE,
      name: 'Phone Tester',
      password: 'secret123',
    });
    expect([200, 201]).toContain(reg.status);
    expect(reg.body.success).toBe(true);
    const memberId = String(reg.body.data.member_id);

    // One comms outbox row enqueued: whatsapp / urgent / PENDING, code inline.
    const outbox = await latestOtpOutbox();
    expect(outbox).not.toBeNull();
    expect(outbox!.channel).toBe('whatsapp');
    expect(outbox!.priority).toBe('urgent');
    expect(outbox!.status).toBe('PENDING');
    const code = (outbox!.payload as { code: string }).code;
    expect(code).toMatch(/^[0-9]{6}$/);

    const verify = await request(app).post('/api/member/auth/validateOtpPhone').send({
      memberId,
      verifyCode: code,
    });
    expect(verify.status).toBe(200);
    expect(verify.body.success).toBe(true);

    const member = await prisma.member.findUnique({ where: { phone: PHONE } });
    expect(member?.isPhoneVerified).toBe(true);
  });

  it('rejects a wrong OTP code', async () => {
    const app = buildApp();

    const reg = await request(app).post('/api/member/auth/registerByPhone').send({
      phone: PHONE,
      phoneCode: PHONE_CODE,
      name: 'Phone Tester',
      password: 'secret123',
    });
    const memberId = String(reg.body.data.member_id);

    const verify = await request(app).post('/api/member/auth/validateOtpPhone').send({
      memberId,
      verifyCode: '000000',
    });
    expect(verify.status).toBe(400);
    expect(verify.body.success).toBe(false);
  });
});
