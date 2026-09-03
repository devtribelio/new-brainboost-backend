import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { prisma } from '@bb/db';
import { buildApp } from '../src/app';

// `members.phone` is stored national-form (no dial code), but the mobile client
// sends E.164 in `phone`. The register conflict lookup used the raw value, so
// an existing '87875439433' was never matched by an incoming '+6287875439433':
// the insert then tripped the unique constraint and the client got a bare
// 409 CONFLICT ("Data sudah ada") instead of 400 PHONE_ALREADY_REGISTERED.

const PHONE = '87875439433';
const PHONE_CODE = '+62';
const OWNER_EMAIL = 'register-phone-owner@test.local';
const NEW_EMAIL = 'register-phone-new@test.local';

async function cleanup() {
  await prisma.praMember.deleteMany({
    where: { OR: [{ phone: PHONE }, { email: { in: [OWNER_EMAIL, NEW_EMAIL] } }] },
  });
  const members = await prisma.member.findMany({
    where: { OR: [{ phone: PHONE }, { email: { in: [OWNER_EMAIL, NEW_EMAIL] } }] },
    select: { id: true },
  });
  for (const m of members) {
    await prisma.refreshToken.deleteMany({ where: { memberId: m.id } });
    await prisma.networkMember.deleteMany({ where: { memberId: m.id } });
    await prisma.member.delete({ where: { id: m.id } });
  }
}

describe('POST /auth/register — phone already taken', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('reports PHONE_ALREADY_REGISTERED when the client sends the number in E.164', async () => {
    const app = buildApp();

    await prisma.member.create({
      data: {
        email: OWNER_EMAIL,
        fullName: 'Phone Owner',
        passwordHash: 'x',
        phone: PHONE,
        phoneCode: PHONE_CODE,
        code: 'RPC001',
        affiliateCode: 'RPC001',
        isActive: true,
        isPhoneVerified: true,
      },
    });

    const res = await request(app).post('/api/member/auth/register').send({
      fullName: 'Parkir',
      email: NEW_EMAIL,
      password: '123456789',
      phone: `${PHONE_CODE}${PHONE}`,
      phoneCode: PHONE_CODE,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PHONE_ALREADY_REGISTERED');
    // The member must not have been created by the failed attempt.
    expect(await prisma.member.findUnique({ where: { email: NEW_EMAIL } })).toBeNull();
  });
});
