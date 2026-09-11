import { describe, it, expect, afterEach } from 'vitest';
import { prisma } from '@bb/db';
import { AuthService } from '@/modules/auth/auth.service';

const svc = new AuthService();
const created: string[] = [];

async function makeMember(phone: string, isPhoneVerified: boolean) {
  const m = await prisma.member.create({
    data: {
      email: `fp-${Date.now()}-${Math.floor(Math.random() * 1e5)}@test.local`,
      passwordHash: 'x',
      fullName: 'FP',
      phone,
      phoneCode: '+62',
      isPhoneVerified,
    },
  });
  created.push(m.id);
  return m;
}

afterEach(async () => {
  await prisma.otpCode.deleteMany({ where: { target: { contains: '8199' } } });
  await prisma.member.deleteMany({ where: { id: { in: created } } });
  created.length = 0;
});

// A phone reaches `members.phone` from paths that never prove it — register by
// phone before its OTP, and the ticket checkout filling an empty profile. If
// password reset accepted those, one mistyped digit would hand the account to
// whoever actually owns the number typed.
describe('forgot password by phone requires a verified number', () => {
  it('refuses a number that was never verified', async () => {
    const phone = `8199${Date.now().toString().slice(-7)}`;
    await makeMember(phone, false);

    // Rejected exactly like an unknown number — same error, no OTP. The caller
    // must not be able to tell the two apart, or the endpoint becomes a probe
    // for which numbers have accounts.
    await expect(svc.requestForgotPassword({ phone } as never)).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_REGISTERED',
    });
    expect(await prisma.otpCode.count({ where: { target: { contains: phone } } })).toBe(0);
  });

  it('still works for a verified number', async () => {
    const phone = `8199${(Date.now() + 1).toString().slice(-7)}`;
    await makeMember(phone, true);

    await svc.requestForgotPassword({ phone } as never);

    expect(await prisma.otpCode.count({ where: { target: { contains: phone } } })).toBe(1);
  });
});
