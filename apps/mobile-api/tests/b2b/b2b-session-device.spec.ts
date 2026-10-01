import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { fcmService } from '@bb/domain/notification/fcm.service';
import { buildApp } from '../../src/app';

/**
 * The company (B2B) app shares the member account with the regular app, so its
 * session bucket and its push devices must be separate: logging into one app, or
 * enrolling a device in it, must never kick or silence the other.
 */
const TAG = `b2bsess-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const email = `${TAG}@test.local`;
const password = 'secret123';
const app = buildApp();
let memberId = '';

async function login(clientType?: 'mobile' | 'b2b') {
  const body: Record<string, string> = { grant_type: 'password', username: email, password };
  if (clientType) body.client_type = clientType;
  const res = await request(app).post('/api/member/oauth/token').send(body);
  expect(res.status).toBe(200);
  return res.body.data.access_token as string;
}
const profile = (token: string) =>
  request(app).get('/api/member/account/profile/info').set('Authorization', `Bearer ${token}`);
const device = (token: string, deviceId: string, fcmToken: string, appHeader?: string) => {
  const r = request(app).post('/api/member/auth/devices').set('Authorization', `Bearer ${token}`);
  if (appHeader) r.set('x-app', appHeader);
  return r.send({ deviceId, platform: 'android', fcmToken });
};

beforeAll(async () => {
  const m = await prisma.member.create({
    data: { email, passwordHash: await bcrypt.hash(password, 4), isActive: true, isEmailVerified: true },
  });
  memberId = m.id;
});

afterAll(async () => {
  await prisma.device.deleteMany({ where: { memberId } });
  await prisma.refreshToken.deleteMany({ where: { memberId } });
  await prisma.member.deleteMany({ where: { email: { startsWith: TAG } } });
  await prisma.$disconnect();
});

describe('session buckets: regular app vs company app', () => {
  it('a b2b login does not kick the mobile session, and vice versa', async () => {
    const mobile1 = await login();
    const b2b1 = await login('b2b');
    expect((await profile(mobile1)).status).toBe(200);
    expect((await profile(b2b1)).status).toBe(200);

    // Second b2b login kicks only the first b2b session.
    const b2b2 = await login('b2b');
    expect((await profile(b2b1)).status).toBe(401);
    expect((await profile(mobile1)).status).toBe(200);

    // Second mobile login kicks only the first mobile session.
    const mobile2 = await login('mobile');
    expect((await profile(mobile1)).status).toBe(401);
    expect((await profile(b2b2)).status).toBe(200);
    expect((await profile(mobile2)).status).toBe(200);

    const rows = await prisma.refreshToken.findMany({ where: { memberId, revokedAt: null } });
    expect(rows.map((r) => r.clientType).sort()).toEqual(['b2b', 'mobile']);
  });
});

describe('push devices are scoped per app', () => {
  it('enrolling a company-app device does not silence the regular app (and back)', async () => {
    const token = await login('b2b');
    expect((await device(token, `${TAG}-phone`, 'tok-regular')).status).toBe(200);
    expect((await device(token, `${TAG}-b2b`, 'tok-b2b', 'b2b')).status).toBe(200);

    let rows = await prisma.device.findMany({ where: { memberId }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((d) => [d.deviceId.replace(`${TAG}-`, ''), d.app, d.fcmToken])).toEqual([
      ['phone', 'brainboost', 'tok-regular'],
      ['b2b', 'b2b', 'tok-b2b'],
    ]);

    // A second regular-app phone takes over the regular app only.
    expect((await device(token, `${TAG}-phone2`, 'tok-regular-2')).status).toBe(200);
    rows = await prisma.device.findMany({ where: { memberId } });
    const by = Object.fromEntries(rows.map((d) => [d.deviceId.replace(`${TAG}-`, ''), d.fcmToken]));
    expect(by).toEqual({ phone: null, phone2: 'tok-regular-2', b2b: 'tok-b2b' });
  });

  it('sendToMember defaults to the regular app; b2b and all are explicit', async () => {
    const sent: string[] = [];
    const svc = fcmService as unknown as { enabled: boolean; auth: unknown; projectId: string };
    const saved = { enabled: svc.enabled, auth: svc.auth, projectId: svc.projectId };
    svc.enabled = true;
    svc.projectId = 'test';
    svc.auth = {
      getClient: async () => ({
        request: vi.fn(async (req: { data: { message: { token: string } } }) => {
          sent.push(req.data.message.token);
          return {};
        }),
      }),
    };
    try {
      await fcmService.sendToMember(memberId, { title: 't' });
      expect(sent).toEqual(['tok-regular-2']);
      sent.length = 0;
      await fcmService.sendToMember(memberId, { title: 't' }, { app: 'b2b' });
      expect(sent).toEqual(['tok-b2b']);
      sent.length = 0;
      await fcmService.sendToMember(memberId, { title: 't' }, { app: 'all' });
      expect(sent.sort()).toEqual(['tok-b2b', 'tok-regular-2']);
    } finally {
      Object.assign(svc, saved);
    }
  });
});

describe('forgot password via email', () => {
  it('sets a password for a B2B-provisioned account and marks the email verified', async () => {
    const target = `${TAG}-prov@test.local`;
    await prisma.member.create({
      data: {
        email: target,
        passwordHash: 'sentinel-sentinel',
        passwordAlgo: 'social',
        isActive: true,
        isEmailVerified: false,
        signupSource: 'b2b',
      },
    });
    expect((await request(app).post('/api/member/auth/requestForgotPassword').send({ email: target })).status).toBe(200);
    const outbox = await prisma.notificationOutbox.findFirst({
      where: { recipient: target, type: 'otp' },
      orderBy: { createdAt: 'desc' },
    });
    const code = (outbox!.payload as { code: string }).code;
    const res = await request(app)
      .post('/api/member/auth/forgotPasswordVerification')
      .send({ email: target, code, newPassword: 'newSecret456' });
    expect(res.status).toBe(200);
    const m = await prisma.member.findUnique({ where: { email: target } });
    expect(m).toMatchObject({ passwordAlgo: 'bcrypt', isEmailVerified: true, signupSource: 'b2b' });
    const loginRes = await request(app)
      .post('/api/member/oauth/token')
      .send({ grant_type: 'password', username: target, password: 'newSecret456', client_type: 'b2b' });
    expect(loginRes.status).toBe(200);
    await prisma.otpCode.deleteMany({ where: { target } });
    await prisma.notificationOutbox.deleteMany({ where: { recipient: target } });
    await prisma.refreshToken.deleteMany({ where: { member: { email: target } } });
  });
});
