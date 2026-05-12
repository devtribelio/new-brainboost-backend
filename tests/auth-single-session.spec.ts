import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app';
import { prisma } from '../src/config/prisma';

describe('auth single-session enforcement', () => {
  const email = `single-session-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  const password = 'secret123';
  const app = buildApp();

  beforeAll(async () => {
    await request(app).post('/api/member/auth/register').send({
      email,
      password,
      confirmPassword: password,
      fullName: 'Single Session Tester',
    });
  });

  afterAll(async () => {
    const member = await prisma.member.findUnique({ where: { email } });
    if (member) {
      await prisma.refreshToken.deleteMany({ where: { memberId: member.id } });
      await prisma.member.delete({ where: { id: member.id } });
    }
    await prisma.$disconnect();
  });

  async function loginPassword() {
    const res = await request(app)
      .post('/api/member/oauth/token')
      .send({ grant_type: 'password', username: email, password });
    expect(res.status).toBe(200);
    return res.body.data as { access_token: string; refresh_token: string };
  }

  async function refresh(refreshToken: string) {
    return request(app)
      .post('/api/member/oauth/token')
      .send({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  it('second password login revokes refresh token from first login', async () => {
    const a = await loginPassword();
    const b = await loginPassword();
    expect(a.refresh_token).not.toBe(b.refresh_token);

    const reuseA = await refresh(a.refresh_token);
    expect(reuseA.status).toBe(401);

    const useB = await refresh(b.refresh_token);
    expect(useB.status).toBe(200);
    expect(useB.body.data.refresh_token).toBeTruthy();
  });

  it('refresh-token grant rotates: prior refresh token becomes unusable after rotation', async () => {
    const a = await loginPassword();
    const rotated = await refresh(a.refresh_token);
    expect(rotated.status).toBe(200);
    const c = rotated.body.data as { refresh_token: string };

    const reuseA = await refresh(a.refresh_token);
    expect(reuseA.status).toBe(401);

    const useC = await refresh(c.refresh_token);
    expect(useC.status).toBe(200);

    const reuseC = await refresh(c.refresh_token);
    expect(reuseC.status).toBe(401);
  });

  it('after any login, member has exactly one non-revoked refresh token', async () => {
    await loginPassword();
    await loginPassword();
    await loginPassword();

    const member = await prisma.member.findUnique({ where: { email } });
    expect(member).toBeTruthy();
    const live = await prisma.refreshToken.count({
      where: { memberId: member!.id, revokedAt: null },
    });
    expect(live).toBe(1);
  });
});
