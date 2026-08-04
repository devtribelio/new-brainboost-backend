import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '@bb/db';
import { otpService, OTP_RESEND_COOLDOWN_SECONDS } from '@bb/common/services/otp.service';

// Phone targets (non-email) so issue() routes to the WhatsApp dispatcher,
// which no-ops in test (Qontak unconfigured) — no network, no email.
const PHONE = '628000000999';

// Most cases here send several OTPs in a row, which the cooldown exists to
// block. Opting out isolates the behaviour under test; the cooldown itself is
// covered by its own cases below.
const NO_COOLDOWN = { resendCooldownSeconds: 0 } as const;

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
});

describe('otpService resend cooldown', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('applies by default, without the caller opting in', async () => {
    await otpService.issue({ target: PHONE, purpose: 'verify-phone' });
    await expect(
      otpService.issue({ target: PHONE, purpose: 'verify-phone' }),
    ).rejects.toMatchObject({ code: 'OTP_RESEND_TOO_SOON' });
  });

  it('reports how long to wait, in seconds and as a timestamp', async () => {
    await otpService.issue({ target: PHONE, purpose: 'verify-phone' });
    await expect(
      otpService.issue({ target: PHONE, purpose: 'verify-phone' }),
    ).rejects.toMatchObject({
      code: 'OTP_RESEND_TOO_SOON',
      details: {
        retryAfter: expect.any(String),
        retryAfterSeconds: expect.any(Number),
      },
    });
  });

  it('is measured from the send, NOT from the previous code expiring', async () => {
    // TTL far shorter than the cooldown: under the old expiry-coupled guard
    // this second send would be allowed the moment the code died.
    await otpService.issue({ target: PHONE, purpose: 'verify-phone', ttlSeconds: 1 });
    await new Promise((r) => setTimeout(r, 1_100));
    await expect(
      otpService.issue({ target: PHONE, purpose: 'verify-phone' }),
    ).rejects.toMatchObject({ code: 'OTP_RESEND_TOO_SOON' });
  });

  it('is not lifted by consuming the code — what is throttled is the message', async () => {
    const { code } = await otpService.issue({ target: PHONE, purpose: 'verify-phone' });
    await otpService.consume(PHONE, code, 'verify-phone');
    await expect(
      otpService.issue({ target: PHONE, purpose: 'verify-phone' }),
    ).rejects.toMatchObject({ code: 'OTP_RESEND_TOO_SOON' });
  });

  it('lets the send through once the window has elapsed', async () => {
    await prisma.otpCode.create({
      data: {
        target: PHONE,
        code: 'x',
        purpose: 'verify-phone',
        expiresAt: new Date(Date.now() + 120_000),
        createdAt: new Date(Date.now() - (OTP_RESEND_COOLDOWN_SECONDS + 1) * 1000),
      },
    });
    await expect(otpService.issue({ target: PHONE, purpose: 'verify-phone' })).resolves.toMatchObject(
      { id: expect.any(String) },
    );
  });
});

describe('otpService resend supersedes the previous code', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('retires the old code so only one is live at a time', async () => {
    const first = await otpService.issue({ target: PHONE, purpose: 'verify-phone' });
    await otpService.issue({ target: PHONE, purpose: 'verify-phone', ...NO_COOLDOWN });

    const live = await prisma.otpCode.count({
      where: { target: PHONE, purpose: 'verify-phone', usedAt: null },
    });
    expect(live).toBe(1);

    const retired = await prisma.otpCode.findUnique({ where: { id: first.id } });
    expect(retired?.usedAt).not.toBeNull();
  });

  it('rejects the superseded code as expired, not as invalid', async () => {
    const first = await otpService.issue({ target: PHONE, purpose: 'verify-phone' });
    await otpService.issue({ target: PHONE, purpose: 'verify-phone', ...NO_COOLDOWN });

    await expect(otpService.verify(PHONE, first.code, 'verify-phone')).rejects.toMatchObject({
      code: 'OTP_EXPIRED',
    });
  });

  it('does not spend the live code’s attempt budget on the superseded one', async () => {
    const first = await otpService.issue({ target: PHONE, purpose: 'verify-phone' });
    const second = await otpService.issue({
      target: PHONE,
      purpose: 'verify-phone',
      ...NO_COOLDOWN,
    });

    await expect(otpService.verify(PHONE, first.code, 'verify-phone')).rejects.toThrow();

    const live = await prisma.otpCode.findUnique({ where: { id: second.id } });
    expect(live?.attempts).toBe(0);
  });

  it('still charges an attempt for a genuinely wrong code', async () => {
    const { id } = await otpService.issue({ target: PHONE, purpose: 'verify-phone' });
    await expect(otpService.verify(PHONE, '111111', 'verify-phone')).rejects.toMatchObject({
      code: 'OTP_INVALID',
    });
    const live = await prisma.otpCode.findUnique({ where: { id } });
    expect(live?.attempts).toBe(1);
  });

  it('does not resurrect an older code once the live one locks out', async () => {
    // The hole this guards: before superseding, locking the newest row (which
    // sets usedAt) made findFirst fall back to the previous unused row, handing
    // out a fresh MAX_OTP_ATTEMPTS budget.
    await otpService.issue({ target: PHONE, purpose: 'verify-phone' });
    await otpService.issue({ target: PHONE, purpose: 'verify-phone', ...NO_COOLDOWN });

    for (let i = 0; i < 5; i++) {
      await expect(otpService.verify(PHONE, '111111', 'verify-phone')).rejects.toThrow();
    }
    await expect(otpService.verify(PHONE, '111111', 'verify-phone')).rejects.toMatchObject({
      code: 'OTP_NOT_FOUND',
    });
  });
});

describe('otpService send cap', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('blocks the 6th WhatsApp request per target+purpose', async () => {
    for (let i = 0; i < 5; i++) {
      await otpService.issue({ target: PHONE, purpose: 'verify-phone', ...NO_COOLDOWN });
    }
    await expect(
      otpService.issue({ target: PHONE, purpose: 'verify-phone', ...NO_COOLDOWN }),
    ).rejects.toMatchObject({ code: 'OTP_DAILY_LIMIT_REACHED' });
  });

  it('uses a rolling 24h window, not a calendar day', async () => {
    // Five sends dated just over 24h ago must not count against the cap — the
    // old setHours(0,0,0,0) boundary would have cleared them at local midnight
    // instead, and counted a burst either side of it separately.
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
    for (let i = 0; i < 5; i++) {
      await prisma.otpCode.create({
        data: {
          target: PHONE,
          code: `x${i}`,
          purpose: 'verify-phone',
          expiresAt: new Date(stale.getTime() + 120_000),
          createdAt: stale,
          usedAt: stale,
        },
      });
    }
    await expect(
      otpService.issue({ target: PHONE, purpose: 'verify-phone' }),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('reports when a slot frees up', async () => {
    for (let i = 0; i < 5; i++) {
      await otpService.issue({ target: PHONE, purpose: 'verify-phone', ...NO_COOLDOWN });
    }
    await expect(
      otpService.issue({ target: PHONE, purpose: 'verify-phone', ...NO_COOLDOWN }),
    ).rejects.toMatchObject({
      details: { retryAfterSeconds: expect.any(Number) },
    });
  });
});
