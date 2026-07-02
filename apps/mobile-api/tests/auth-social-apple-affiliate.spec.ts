import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';

// Mock the Apple identity verifier so the social grant never reaches Apple's
// JWKS. verifyAppleIdentityToken is the seam we drive per-test.
const { verifyAppleMock } = vi.hoisted(() => ({ verifyAppleMock: vi.fn() }));
vi.mock('../src/modules/auth/social/apple-verifier', () => ({
  verifyAppleIdentityToken: verifyAppleMock,
}));

import { buildApp } from '../src/app';
import { prisma } from '@bb/db';

const app = buildApp();

interface MockApplePayload {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name?: string | null;
}

function setAppleResponse(payload: MockApplePayload) {
  verifyAppleMock.mockResolvedValueOnce(payload);
}

function tokenRequest(body: Record<string, unknown>) {
  return request(app).post('/api/member/oauth/token').send(body);
}

const testEmails: string[] = [];
function trackedEmail(prefix: string): string {
  const e = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}@social-apple.test.local`;
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
  verifyAppleMock.mockReset();
});

async function registerInviter(prefix: string): Promise<{ id: string; affiliateCode: string }> {
  const email = trackedEmail(prefix);
  const reg = await request(app)
    .post('/api/member/auth/register')
    .send({ email, password: 'secret123', fullName: 'Inviter' });
  expect([200, 201]).toContain(reg.status);
  const inviter = await prisma.member.findUnique({
    where: { email },
    select: { id: true, affiliateCode: true },
  });
  expect(inviter!.affiliateCode).toBeTruthy();
  return { id: inviter!.id, affiliateCode: inviter!.affiliateCode! };
}

describe('auth social apple grant — affiliate attribution', () => {
  it('new apple signup with affiliateCode binds inviterId (create path only)', async () => {
    const inviter = await registerInviter('apl-inviter');

    const email = trackedEmail('apl-invitee');
    const sub = `as-${Date.now()}-aff`;
    setAppleResponse({ sub, email, emailVerified: true, name: 'Invitee' });
    const res = await tokenRequest({
      grant_type: 'social',
      provider: 'apple',
      social_token: 'fake.apple.token',
      affiliateCode: inviter.affiliateCode,
    });
    expect(res.status).toBe(200);

    const created = await prisma.member.findUnique({ where: { email } });
    expect(created!.appleSub).toBe(sub);
    expect(created!.inviterId).toBe(inviter.id);
  });

  it('affiliateCode on an already-existing apple account is ignored (inviterId never updated)', async () => {
    const inviter = await registerInviter('apl-inviter2');

    const email = trackedEmail('apl-existing');
    const sub = `as-${Date.now()}-exist`;

    // First signup WITHOUT affiliateCode → inviterId stays null.
    setAppleResponse({ sub, email, emailVerified: true, name: 'Existing' });
    const first = await tokenRequest({
      grant_type: 'social',
      provider: 'apple',
      social_token: 'fake.apple.token',
    });
    expect(first.status).toBe(200);
    const before = await prisma.member.findUnique({ where: { email } });
    expect(before!.inviterId).toBeNull();

    // Second login (fast-path via appleSub) WITH affiliateCode → must NOT update.
    setAppleResponse({ sub, email, emailVerified: true, name: 'Existing' });
    const second = await tokenRequest({
      grant_type: 'social',
      provider: 'apple',
      social_token: 'fake.apple.token',
      affiliateCode: inviter.affiliateCode,
    });
    expect(second.status).toBe(200);
    const after = await prisma.member.findUnique({ where: { email } });
    expect(after!.inviterId).toBeNull();
  });
});
