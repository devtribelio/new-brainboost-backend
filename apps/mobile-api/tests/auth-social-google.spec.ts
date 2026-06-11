import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';

const { verifyIdTokenMock } = vi.hoisted(() => ({ verifyIdTokenMock: vi.fn() }));
vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    verifyIdToken: verifyIdTokenMock,
  })),
}));

import { buildApp } from '../src/app';
import { prisma } from '@bb/db';

const app = buildApp();

interface MockGooglePayload {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
}

function setGoogleResponse(payload: MockGooglePayload) {
  verifyIdTokenMock.mockResolvedValueOnce({ getPayload: () => payload });
}

function setGoogleFailure(reason = 'invalid_signature') {
  verifyIdTokenMock.mockRejectedValueOnce(new Error(reason));
}

function tokenRequest(body: Record<string, unknown>) {
  return request(app).post('/api/member/oauth/token').send(body);
}

const testEmails: string[] = [];
function trackedEmail(prefix: string): string {
  const e = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}@social-google.test.local`;
  testEmails.push(e);
  return e;
}

afterAll(async () => {
  if (testEmails.length > 0) {
    const members = await prisma.member.findMany({
      where: { email: { in: testEmails } },
      select: { id: true },
    });
    const ids = members.map((m) => m.id);
    if (ids.length > 0) {
      await prisma.refreshToken.deleteMany({ where: { memberId: { in: ids } } });
      await prisma.member.deleteMany({ where: { id: { in: ids } } });
    }
  }
  await prisma.$disconnect();
});

beforeEach(() => {
  verifyIdTokenMock.mockReset();
});

describe('auth social google grant', () => {
  it('valid id_token → 200 token bundle envelope matching password grant', async () => {
    const email = trackedEmail('new');
    setGoogleResponse({ sub: `gs-${Date.now()}-1`, email, email_verified: true, name: 'New User' });

    const res = await tokenRequest({
      grant_type: 'social',
      provider: 'google',
      social_token: 'fake.id.token',
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.access_token).toBeTruthy();
    expect(res.body.data.refresh_token).toBeTruthy();
    expect(res.body.data.token_type).toBe('Bearer');
    expect(typeof res.body.data.expires_in).toBe('number');
  });

  it('verifier throws (bad sig / wrong audience) → 401', async () => {
    setGoogleFailure('audience_mismatch');
    const res = await tokenRequest({
      grant_type: 'social',
      provider: 'google',
      social_token: 'tampered.token',
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('email_verified=false → 401', async () => {
    setGoogleResponse({
      sub: `gs-${Date.now()}-unv`,
      email: trackedEmail('unv'),
      email_verified: false,
    });
    const res = await tokenRequest({
      grant_type: 'social',
      provider: 'google',
      social_token: 'fake.id.token',
    });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('google_email_not_verified');
  });

  it('new email creates member with isVerified=true and passwordAlgo=social', async () => {
    const email = trackedEmail('create');
    const sub = `gs-${Date.now()}-create`;
    setGoogleResponse({ sub, email, email_verified: true, name: 'Creator' });

    const res = await tokenRequest({
      grant_type: 'social',
      provider: 'google',
      social_token: 'fake.id.token',
    });

    expect(res.status).toBe(200);
    const member = await prisma.member.findUnique({ where: { email } });
    expect(member).toBeTruthy();
    expect(member!.isVerified).toBe(true);
    expect(member!.passwordAlgo).toBe('social');
    expect(member!.googleSub).toBe(sub);
  });

  it('second login with same google sub → no duplicate, fast-path via googleSub', async () => {
    const email = trackedEmail('repeat');
    const sub = `gs-${Date.now()}-repeat`;

    setGoogleResponse({ sub, email, email_verified: true, name: 'Repeat User' });
    const first = await tokenRequest({
      grant_type: 'social',
      provider: 'google',
      social_token: 'fake.id.token',
    });
    expect(first.status).toBe(200);

    setGoogleResponse({ sub, email, email_verified: true, name: 'Repeat User' });
    const second = await tokenRequest({
      grant_type: 'social',
      provider: 'google',
      social_token: 'fake.id.token',
    });
    expect(second.status).toBe(200);

    const count = await prisma.member.count({ where: { email } });
    expect(count).toBe(1);
  });

  it('existing verified member same email + no googleSub → link (no duplicate)', async () => {
    const email = trackedEmail('link');
    const password = 'secret123';
    const reg = await request(app)
      .post('/api/member/auth/register')
      .send({ email, password, fullName: 'Link Target' });
    expect([200, 201]).toContain(reg.status);

    await prisma.member.update({
      where: { email },
      data: { isVerified: true, isActive: true },
    });

    const sub = `gs-${Date.now()}-link`;
    setGoogleResponse({ sub, email, email_verified: true, name: 'Link Target' });
    const res = await tokenRequest({
      grant_type: 'social',
      provider: 'google',
      social_token: 'fake.id.token',
    });
    expect(res.status).toBe(200);

    const linked = await prisma.member.findUnique({ where: { email } });
    expect(linked!.googleSub).toBe(sub);
    const count = await prisma.member.count({ where: { email } });
    expect(count).toBe(1);
  });

  it('existing unverified member same email → 400 email_in_use_unverified (prevent takeover)', async () => {
    const email = trackedEmail('takeover');
    const password = 'secret123';
    const reg = await request(app)
      .post('/api/member/auth/register')
      .send({ email, password, fullName: 'Unverified Local' });
    expect([200, 201]).toContain(reg.status);
    // Member.isVerified default = false; do NOT flip.

    setGoogleResponse({
      sub: `gs-${Date.now()}-take`,
      email,
      email_verified: true,
      name: 'Attacker',
    });
    const res = await tokenRequest({
      grant_type: 'social',
      provider: 'google',
      social_token: 'fake.id.token',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('email_in_use_unverified');
  });

  it('single-session: prior mobile session revoked after social login', async () => {
    const email = trackedEmail('bucket');
    const sub = `gs-${Date.now()}-bucket`;

    setGoogleResponse({ sub, email, email_verified: true, name: 'Bucket User' });
    const first = await tokenRequest({
      grant_type: 'social',
      provider: 'google',
      social_token: 'fake.id.token',
      client_type: 'mobile',
    });
    expect(first.status).toBe(200);
    const firstRefresh = first.body.data.refresh_token as string;

    setGoogleResponse({ sub, email, email_verified: true, name: 'Bucket User' });
    const second = await tokenRequest({
      grant_type: 'social',
      provider: 'google',
      social_token: 'fake.id.token',
      client_type: 'mobile',
    });
    expect(second.status).toBe(200);

    const reuse = await tokenRequest({ grant_type: 'refresh_token', refresh_token: firstRefresh });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.message).toBe('session_revoked');
  });

  it('password grant on social-only account is rejected', async () => {
    const email = trackedEmail('passguard');
    const sub = `gs-${Date.now()}-passguard`;
    setGoogleResponse({ sub, email, email_verified: true, name: 'Pass Guard' });
    const social = await tokenRequest({
      grant_type: 'social',
      provider: 'google',
      social_token: 'fake.id.token',
    });
    expect(social.status).toBe(200);

    const password = await tokenRequest({
      grant_type: 'password',
      username: email,
      password: 'anything',
    });
    expect(password.status).toBe(401);
  });

  it('missing social_token → 400 validation', async () => {
    const res = await tokenRequest({ grant_type: 'social', provider: 'google' });
    expect(res.status).toBe(400);
  });

  it('unsupported provider → 400', async () => {
    setGoogleResponse({ sub: 'x', email: 't@x.com', email_verified: true });
    const res = await tokenRequest({
      grant_type: 'social',
      provider: 'facebook',
      social_token: 'fake.id.token',
    });
    expect(res.status).toBe(400);
  });
});
