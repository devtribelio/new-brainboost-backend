import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { prisma } from '@bb/db';
import { otpService } from '@bb/common/services/otp.service';

// Phone targets (non-email) so issue() routes to the WhatsApp dispatcher, which
// no-ops in test (Qontak unconfigured) — no network, no email.
const TESTER_PHONE = '628111222333';
const NORMAL_PHONE = '628999888777';
const FIXED = '000000';

// testAccountConfig() reads process.env live, so we toggle it per-test. Vitest
// runs with --no-file-parallelism, so mutating process.env globally is safe.
const saved: Record<string, string | undefined> = {};
function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
function restoreEnv(): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(saved)) delete saved[key];
}

async function cleanup() {
  await prisma.otpCode.deleteMany({ where: { target: { in: [TESTER_PHONE, NORMAL_PHONE] } } });
}

describe('otpService test-account fixed-OTP bypass', () => {
  beforeEach(async () => {
    await cleanup();
    setEnv('TEST_ACCOUNT_ENABLED', 'true');
    setEnv('TEST_ACCOUNT_OTP_CODE', FIXED);
    setEnv('TEST_ACCOUNT_IDENTIFIERS', TESTER_PHONE);
  });
  afterEach(() => {
    restoreEnv();
  });
  afterAll(cleanup);

  it('issue() stores no otp_codes row and returns the fixed code for a tester', async () => {
    const res = await otpService.issue({ target: TESTER_PHONE, purpose: 'verify-phone' });
    expect(res.code).toBe(FIXED);
    const rows = await prisma.otpCode.count({ where: { target: TESTER_PHONE } });
    expect(rows).toBe(0);
  });

  it('verify() and consume() accept the fixed code for a tester', async () => {
    await otpService.issue({ target: TESTER_PHONE, purpose: 'verify-phone' });
    await expect(otpService.verify(TESTER_PHONE, FIXED, 'verify-phone')).resolves.toBeUndefined();
    await expect(otpService.consume(TESTER_PHONE, FIXED, 'verify-phone')).resolves.toBeUndefined();
  });

  it('rejects a wrong code even for a tester target', async () => {
    await otpService.issue({ target: TESTER_PHONE, purpose: 'verify-phone' });
    await expect(otpService.verify(TESTER_PHONE, '123456', 'verify-phone')).rejects.toThrow();
  });

  it('does NOT bypass a target outside the whitelist', async () => {
    // Normal target: issue() writes a real random code; the fixed code must fail.
    await otpService.issue({ target: NORMAL_PHONE, purpose: 'verify-phone' });
    await expect(otpService.verify(NORMAL_PHONE, FIXED, 'verify-phone')).rejects.toThrow();
  });

  it('does NOT bypass when disabled, even for a whitelisted target', async () => {
    setEnv('TEST_ACCOUNT_ENABLED', 'false');
    // Disabled → issue() generates a real random code; fixed code must fail.
    await otpService.issue({ target: TESTER_PHONE, purpose: 'verify-phone' });
    await expect(otpService.verify(TESTER_PHONE, FIXED, 'verify-phone')).rejects.toThrow();
  });
});
