import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '@bb/db';
import { whatsappService } from '@bb/common/services/whatsapp.service';
import { buildApp } from '../src/app';

// Phone-register issues a WhatsApp OTP. In test Qontak is unconfigured, so we
// spy on the dispatcher to capture the generated code (it never leaves the
// backend otherwise — it's bcrypt-hashed in the DB).
const PHONE = '81299900099';
const PHONE_CODE = '+62';
const TARGET = `${PHONE_CODE}${PHONE}`;

async function cleanup() {
  await prisma.otpCode.deleteMany({ where: { target: TARGET } });
  await prisma.member.deleteMany({ where: { phone: PHONE } });
}

describe('phone OTP flow (register → verify)', () => {
  beforeEach(cleanup);
  afterAll(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });

  it('registers by phone, then verifies with the issued OTP', async () => {
    const app = buildApp();
    const sendOtp = vi.spyOn(whatsappService, 'sendOtp').mockResolvedValue(true);

    const reg = await request(app).post('/api/member/auth/registerByPhone').send({
      phone: PHONE,
      phoneCode: PHONE_CODE,
      name: 'Phone Tester',
      password: 'secret123',
    });
    expect([200, 201]).toContain(reg.status);
    expect(reg.body.success).toBe(true);
    const memberId = String(reg.body.data.member_id);

    // Dispatcher called once with the target phone + a 6-digit code.
    expect(sendOtp).toHaveBeenCalledTimes(1);
    const [toArg, , codeArg] = sendOtp.mock.calls[0]!;
    expect(toArg).toBe(TARGET);
    expect(codeArg).toMatch(/^[0-9]{6}$/);

    const verify = await request(app).post('/api/member/auth/validateOtpPhone').send({
      memberId,
      verifyCode: codeArg,
    });
    expect(verify.status).toBe(200);
    expect(verify.body.success).toBe(true);

    const member = await prisma.member.findUnique({ where: { phone: PHONE } });
    expect(member?.isPhoneVerified).toBe(true);
  });

  it('rejects a wrong OTP code', async () => {
    const app = buildApp();
    vi.spyOn(whatsappService, 'sendOtp').mockResolvedValue(true);

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
