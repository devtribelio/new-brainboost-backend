import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app';
import { prisma } from '@bb/db';

describe('auth client-type session buckets', () => {
  const email = `bucket-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  const password = 'secret123';
  const app = buildApp();

  beforeAll(async () => {
    const res = await request(app).post('/api/member/auth/register').send({
      email,
      password,
      fullName: 'Bucket Tester',
    });
    expect([200, 201]).toContain(res.status);
  });

  afterAll(async () => {
    const member = await prisma.member.findUnique({ where: { email } });
    if (member) {
      await prisma.refreshToken.deleteMany({ where: { memberId: member.id } });
      await prisma.member.delete({ where: { id: member.id } });
    }
    await prisma.$disconnect();
  });

  async function login(clientType?: 'mobile' | 'web') {
    const body: Record<string, string> = {
      grant_type: 'password',
      username: email,
      password,
    };
    if (clientType) body.client_type = clientType;
    const res = await request(app).post('/api/member/oauth/token').send(body);
    expect(res.status).toBe(200);
    return res.body.data as { access_token: string; refresh_token: string };
  }

  function refresh(refreshToken: string) {
    return request(app)
      .post('/api/member/oauth/token')
      .send({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  function profile(accessToken: string) {
    return request(app)
      .get('/api/member/account/profile/info')
      .set('Authorization', `Bearer ${accessToken}`);
  }

  async function memberId(): Promise<string> {
    const m = await prisma.member.findUnique({ where: { email } });
    expect(m).toBeTruthy();
    return m!.id;
  }

  it('login without clientType lands in the mobile bucket (backward compat)', async () => {
    await prisma.refreshToken.deleteMany({ where: { member: { email } } });
    await login();
    const rows = await prisma.refreshToken.findMany({
      where: { memberId: await memberId() },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.clientType).toBe('mobile');
  });

  it('login with clientType=web stores a web bucket row', async () => {
    await prisma.refreshToken.deleteMany({ where: { member: { email } } });
    await login('web');
    const rows = await prisma.refreshToken.findMany({
      where: { memberId: await memberId() },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.clientType).toBe('web');
  });

  it('web login does NOT kick prior mobile session', async () => {
    await prisma.refreshToken.deleteMany({ where: { member: { email } } });
    const mobile = await login('mobile');
    const web = await login('web');

    const meMobile = await profile(mobile.access_token);
    expect(meMobile.status).toBe(200);

    const meWeb = await profile(web.access_token);
    expect(meWeb.status).toBe(200);

    const liveMobile = await prisma.refreshToken.count({
      where: { memberId: await memberId(), clientType: 'mobile', revokedAt: null },
    });
    const liveWeb = await prisma.refreshToken.count({
      where: { memberId: await memberId(), clientType: 'web', revokedAt: null },
    });
    expect(liveMobile).toBe(1);
    expect(liveWeb).toBe(1);
  });

  it('mobile login does NOT kick prior web session', async () => {
    await prisma.refreshToken.deleteMany({ where: { member: { email } } });
    const web = await login('web');
    const mobile = await login('mobile');

    const meWeb = await profile(web.access_token);
    expect(meWeb.status).toBe(200);

    const meMobile = await profile(mobile.access_token);
    expect(meMobile.status).toBe(200);
  });

  it('two web logins coexist (multi-session) — no kick between web sessions', async () => {
    await prisma.refreshToken.deleteMany({ where: { member: { email } } });
    const webA = await login('web');
    const webB = await login('web');
    expect(webA.access_token).not.toBe(webB.access_token);

    const meA = await profile(webA.access_token);
    const meB = await profile(webB.access_token);
    expect(meA.status).toBe(200);
    expect(meB.status).toBe(200);

    const live = await prisma.refreshToken.count({
      where: { memberId: await memberId(), clientType: 'web', revokedAt: null },
    });
    expect(live).toBe(2);
  });

  it('mobile login still kicks prior mobile session (single-login regression)', async () => {
    await prisma.refreshToken.deleteMany({ where: { member: { email } } });
    const first = await login('mobile');
    const second = await login('mobile');

    const meFirst = await profile(first.access_token);
    expect(meFirst.status).toBe(401);

    const meSecond = await profile(second.access_token);
    expect(meSecond.status).toBe(200);
  });

  it('refreshing a mobile token does not touch web sessions', async () => {
    await prisma.refreshToken.deleteMany({ where: { member: { email } } });
    const mobile = await login('mobile');
    const web = await login('web');

    const rotated = await refresh(mobile.refresh_token);
    expect(rotated.status).toBe(200);

    const meWebAfter = await profile(web.access_token);
    expect(meWebAfter.status).toBe(200);

    const liveWeb = await prisma.refreshToken.count({
      where: { memberId: await memberId(), clientType: 'web', revokedAt: null },
    });
    expect(liveWeb).toBe(1);
  });

  it('refreshing one web token does not touch sibling web sessions', async () => {
    await prisma.refreshToken.deleteMany({ where: { member: { email } } });
    const webA = await login('web');
    const webB = await login('web');

    const rotated = await refresh(webA.refresh_token);
    expect(rotated.status).toBe(200);

    const meBAfter = await profile(webB.access_token);
    expect(meBAfter.status).toBe(200);

    const liveWeb = await prisma.refreshToken.count({
      where: { memberId: await memberId(), clientType: 'web', revokedAt: null },
    });
    expect(liveWeb).toBe(2);
  });

  it('rotated refresh inherits its row clientType (mobile rotation stays mobile)', async () => {
    await prisma.refreshToken.deleteMany({ where: { member: { email } } });
    const mobile = await login('mobile');
    const rotated = await refresh(mobile.refresh_token);
    expect(rotated.status).toBe(200);
    const newRow = await prisma.refreshToken.findFirst({
      where: { memberId: await memberId(), revokedAt: null },
    });
    expect(newRow?.clientType).toBe('mobile');
  });
});
