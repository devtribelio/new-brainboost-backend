import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { buildApp } from '../../src/app';
import { prisma } from '@bb/db';
import { clearActivityThrottle } from '@bb/common/utils/member-activity.util';

/**
 * The unopened-push budget re-arms on ANY authenticated member request, because
 * the app only calls /member/info on cold start — see member-activity.util.ts.
 */

const app = buildApp();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PASSWORD = 'secret123';

let memberId = '';
let accessToken = '';

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pushCount(): Promise<number> {
  const m = await prisma.member.findUnique({
    where: { id: memberId },
    select: { unopenedPushCount: true },
  });
  return m!.unopenedPushCount;
}

async function setCount(n: number) {
  await prisma.member.update({ where: { id: memberId }, data: { unopenedPushCount: n } });
}

beforeAll(async () => {
  const email = `rearm-${suffix}@test.local`;
  const member = await prisma.member.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      fullName: 'Rearm Tester',
      isEmailVerified: true,
    },
  });
  memberId = member.id;

  const res = await request(app)
    .post('/api/member/oauth/token')
    .send({ grant_type: 'password', username: email, password: PASSWORD });
  expect(res.status).toBe(200);
  accessToken = res.body.data.access_token as string;
});

beforeEach(async () => {
  clearActivityThrottle();
  await setCount(5);
});

afterAll(async () => {
  await prisma.refreshToken.deleteMany({ where: { memberId } });
  await prisma.member.deleteMany({ where: { id: memberId } });
});

describe('unopened push budget re-arm on any authenticated request', () => {
  it('resets on a plain authGuard endpoint (no /member/info needed)', async () => {
    await request(app)
      .get('/api/member/notification/list')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    await wait(150); // fire-and-forget
    expect(await pushCount()).toBe(0);
  });

  it('resets via optionalAuthGuard when a member token is present', async () => {
    await request(app)
      .get('/api/member/topic/list')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    await wait(150);
    expect(await pushCount()).toBe(0);
  });

  it('leaves lastActiveAt untouched — dormant re-KYC depends on it going stale', async () => {
    const stale = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    await prisma.member.update({ where: { id: memberId }, data: { lastActiveAt: stale } });

    await request(app)
      .get('/api/member/notification/list')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    await wait(150);

    const m = await prisma.member.findUnique({
      where: { id: memberId },
      select: { lastActiveAt: true, unopenedPushCount: true },
    });
    expect(m!.lastActiveAt?.getTime()).toBe(stale.getTime());
    expect(m!.unopenedPushCount).toBe(0);
  });

  it('throttles: a second request inside the window does not re-write', async () => {
    await request(app)
      .get('/api/member/notification/list')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    await wait(150);
    expect(await pushCount()).toBe(0);

    // Counter climbs again while the throttle window is still open.
    await setCount(4);
    await request(app)
      .get('/api/member/notification/list')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    await wait(150);
    expect(await pushCount()).toBe(4);

    // Window cleared → the next request re-arms again.
    clearActivityThrottle();
    await request(app)
      .get('/api/member/notification/list')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    await wait(150);
    expect(await pushCount()).toBe(0);
  });

  it('does not re-arm for an unauthenticated request', async () => {
    await request(app).get('/api/member/topic/list').expect(200);
    await wait(150);
    expect(await pushCount()).toBe(5);
  });
});
