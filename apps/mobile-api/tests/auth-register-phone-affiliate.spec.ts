import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { prisma } from '@bb/db';
import { buildApp } from '../src/app';

// registerByPhone used to drop affiliateCode entirely: the DTO had no such
// field and validateDto runs class-validator with `whitelist: true`, which
// deletes undecorated props off the instance — so a code the FE sent never
// reached the service and `inviter_id` stayed NULL on every phone signup.

const app = buildApp();

const PHONE_CODE = '+62';
const phones: string[] = [];
const emails: string[] = [];

function trackedPhone(): string {
  // 11 digits, distinct per call: the register-phone limiter keys on the target.
  const p = `8129${String(Date.now()).slice(-5)}${Math.floor(Math.random() * 100)
    .toString()
    .padStart(2, '0')}`;
  phones.push(p);
  return p;
}

function registerByPhone(phone: string, body: Record<string, unknown> = {}) {
  return request(app)
    .post('/api/member/auth/registerByPhone')
    .send({ phone, phoneCode: PHONE_CODE, name: 'Phone Invitee', password: 'secret123', ...body });
}

async function registerInviter(): Promise<{ id: string; affiliateCode: string }> {
  const email = `rpa-inviter-${Date.now()}-${Math.floor(Math.random() * 1e9)}@phone-aff.test.local`;
  emails.push(email);
  const reg = await request(app)
    .post('/api/member/auth/register')
    .send({ email, password: 'secret123', fullName: 'Phone Inviter' });
  expect([200, 201]).toContain(reg.status);
  const inviter = await prisma.member.findUnique({
    where: { email },
    select: { id: true, affiliateCode: true },
  });
  expect(inviter!.affiliateCode).toBeTruthy();
  return { id: inviter!.id, affiliateCode: inviter!.affiliateCode! };
}

afterAll(async () => {
  const targets = phones.map((p) => `${PHONE_CODE}${p}`);
  await prisma.otpCode.deleteMany({ where: { target: { in: targets } } });
  await prisma.notificationOutbox.deleteMany({ where: { recipient: { in: targets } } });
  await prisma.member.deleteMany({ where: { phone: { in: phones } } });
  await prisma.member.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

describe('AuthService.registerByPhone — affiliate attribution', () => {
  it('binds inviterId from affiliateCode on the create path', async () => {
    const inviter = await registerInviter();
    const phone = trackedPhone();

    const res = await registerByPhone(phone, { affiliateCode: inviter.affiliateCode });
    expect([200, 201]).toContain(res.status);

    const member = await prisma.member.findUnique({ where: { phone } });
    expect(member!.inviterId).toBe(inviter.id);
  });

  it('leaves inviterId null when the affiliateCode matches no member', async () => {
    const phone = trackedPhone();

    const res = await registerByPhone(phone, { affiliateCode: 'ZZZZZZZZ' });
    expect([200, 201]).toContain(res.status);

    const member = await prisma.member.findUnique({ where: { phone } });
    expect(member!.inviterId).toBeNull();
  });

  it('binds inviterId when re-registering over an abandoned-at-OTP placeholder', async () => {
    const inviter = await registerInviter();
    const phone = trackedPhone();

    // First attempt, no code — placeholder row, inviterId null.
    expect([200, 201]).toContain((await registerByPhone(phone)).status);
    expect((await prisma.member.findUnique({ where: { phone } }))!.inviterId).toBeNull();

    // Retry from the invite link: the placeholder is overwritten in place.
    const retry = await registerByPhone(phone, { affiliateCode: inviter.affiliateCode });
    expect([200, 201]).toContain(retry.status);

    const member = await prisma.member.findUnique({ where: { phone } });
    expect(member!.inviterId).toBe(inviter.id);
  });

  it('keeps an inviter already on the placeholder when the retry carries no code', async () => {
    const inviter = await registerInviter();
    const phone = trackedPhone();

    expect([200, 201]).toContain(
      (await registerByPhone(phone, { affiliateCode: inviter.affiliateCode })).status,
    );

    // No code this time — undefined must be a Prisma no-op, not a wipe.
    expect([200, 201]).toContain((await registerByPhone(phone)).status);

    const member = await prisma.member.findUnique({ where: { phone } });
    expect(member!.inviterId).toBe(inviter.id);
  });
});
