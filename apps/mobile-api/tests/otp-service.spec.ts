import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '@bb/db';
import { otpService } from '@bb/common/services/otp.service';

// Phone targets (non-email) so issue() routes to the WhatsApp dispatcher,
// which no-ops in test (Qontak unconfigured) — no network, no email.
const PHONE = '628000000999';

async function cleanup() {
  await prisma.otpCode.deleteMany({ where: { target: PHONE } });
}

describe('otpService phone OTP parity', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('verify-phone OTP expires in ~2 minutes (legacy parity)', async () => {
    const before = Date.now();
    const { expiresAt } = await otpService.issue({ target: PHONE, purpose: 'verify-phone' });
    const ttlMs = expiresAt.getTime() - before;
    // 2 min ± small slack for execution time.
    expect(ttlMs).toBeGreaterThan(115_000);
    expect(ttlMs).toBeLessThanOrEqual(120_500);
  });

  it('resend guard rejects while a valid OTP still exists (errCode 2113)', async () => {
    await otpService.issue({ target: PHONE, purpose: 'verify-phone', enforceResendGuard: true });
    await expect(
      otpService.issue({ target: PHONE, purpose: 'verify-phone', enforceResendGuard: true }),
    ).rejects.toThrow(/already sent/i);
  });

  it('resend is allowed again once the prior OTP is consumed', async () => {
    const { code } = await otpService.issue({
      target: PHONE,
      purpose: 'verify-phone',
      enforceResendGuard: true,
    });
    await otpService.consume(PHONE, code, 'verify-phone');
    await expect(
      otpService.issue({ target: PHONE, purpose: 'verify-phone', enforceResendGuard: true }),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('daily cap blocks the 6th request per target+purpose', async () => {
    for (let i = 0; i < 5; i++) {
      await otpService.issue({ target: PHONE, purpose: 'verify-phone', maxPerDay: 5 });
    }
    await expect(
      otpService.issue({ target: PHONE, purpose: 'verify-phone', maxPerDay: 5 }),
    ).rejects.toThrow(/maximum number of OTP requests/i);
  });
});
