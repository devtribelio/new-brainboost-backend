import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import { prisma } from '@bb/db';
import { settingsService, SETTING_KEYS, SettingsService } from '@bb/common/services/settings.service';
import { buildApp } from '../src/app';

const app = buildApp();
const PASSWORD = 'secret123';
const createdEmails: string[] = [];

function uniqueEmail(tag: string): string {
  return `terms-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
}

async function makeMember(tag: string) {
  const email = uniqueEmail(tag);
  createdEmails.push(email);
  await request(app)
    .post('/api/member/auth/register')
    .send({ email, password: PASSWORD, fullName: 'Terms Tester' });
  await prisma.member.update({ where: { email }, data: { isActive: true, isEmailVerified: true } });
  const member = await prisma.member.findUniqueOrThrow({ where: { email } });
  return { email, id: member.id };
}

async function loginOk(email: string) {
  const res = await request(app)
    .post('/api/member/oauth/token')
    .send({ grant_type: 'password', username: email, password: PASSWORD, client_type: 'web' });
  expect(res.status).toBe(200);
  return (res.body.data as { access_token: string }).access_token;
}

async function setSetting(key: string, value: string) {
  await settingsService.set(key, value);
  SettingsService.clearCache();
}

async function profileTerms(token: string) {
  const res = await request(app)
    .get('/api/member/account/profile/info')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body.data.terms as {
    enabled: boolean;
    currentVersion: string;
    url: string;
    acceptedVersion: string | null;
    acceptedAt: string | null;
    needsAcceptance: boolean;
  };
}

function accept(token: string, version: string, platform?: string) {
  const req = request(app)
    .post('/api/member/account/acceptTerms')
    .set('Authorization', `Bearer ${token}`);
  if (platform) req.set('x-platform', platform);
  return req.send({ version });
}

const V1 = 'test-v1';
const V2 = 'test-v2';
const saved: Record<string, string> = {};

beforeAll(async () => {
  for (const key of [SETTING_KEYS.termsEnabled, SETTING_KEYS.termsCurrentVersion, SETTING_KEYS.termsUrl]) {
    saved[key] = await settingsService.get(key, '');
  }
  await setSetting(SETTING_KEYS.termsEnabled, 'true');
  await setSetting(SETTING_KEYS.termsCurrentVersion, V1);
  await setSetting(SETTING_KEYS.termsUrl, 'https://example.test/terms');
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) await setSetting(key, value);
  const ids = (
    await prisma.member.findMany({
      where: { OR: [{ email: { in: createdEmails } }, { email: { contains: 'terms-' } }] },
      select: { id: true },
    })
  ).map((m) => m.id);
  if (ids.length === 0) return;
  await prisma.refreshToken.deleteMany({ where: { memberId: { in: ids } } });
  await prisma.networkMember.deleteMany({ where: { memberId: { in: ids } } });
  await prisma.memberProfile.deleteMany({ where: { memberId: { in: ids } } });
  // member_terms_acceptances cascades with the member row.
  await prisma.member.deleteMany({ where: { id: { in: ids } } });
});

describe('terms acceptance', () => {
  it('rejects an unauthenticated accept', async () => {
    const res = await request(app).post('/api/member/account/acceptTerms').send({ version: V1 });
    expect(res.status).toBe(401);
  });

  it('flags a member who never accepted, and clears it after accept', async () => {
    const { id, email } = await makeMember('fresh');
    const token = await loginOk(email);

    const before = await profileTerms(token);
    expect(before).toMatchObject({
      enabled: true,
      currentVersion: V1,
      url: 'https://example.test/terms',
      acceptedVersion: null,
      acceptedAt: null,
      needsAcceptance: true,
    });

    const res = await accept(token, V1, 'android/3.3.1+412');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ acceptedVersion: V1, needsAcceptance: false });
    expect(typeof res.body.data.acceptedAt).toBe('string');

    // Profile reads the same answer.
    const after = await profileTerms(token);
    expect(after).toMatchObject({ acceptedVersion: V1, needsAcceptance: false });
    expect(after.acceptedAt).toBe(res.body.data.acceptedAt);

    // One audit row, header split into its two columns.
    const rows = await prisma.memberTermsAcceptance.findMany({ where: { memberId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ termsVersion: V1, platform: 'android', appVersion: '3.3.1+412' });
  });

  it('is idempotent: a repeat accept keeps the original row and timestamp', async () => {
    const { id, email } = await makeMember('repeat');
    const token = await loginOk(email);

    const first = await accept(token, V1);
    expect(first.status).toBe(200);
    const second = await accept(token, V1);
    expect(second.status).toBe(200);
    expect(second.body.data.acceptedAt).toBe(first.body.data.acceptedAt);

    expect(await prisma.memberTermsAcceptance.count({ where: { memberId: id } })).toBe(1);
  });

  it('refuses a stale version and names the live one', async () => {
    const { email } = await makeMember('stale');
    const token = await loginOk(email);

    const res = await accept(token, 'something-old');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TERMS_VERSION_STALE');
    expect(res.body.error.details).toEqual({ currentVersion: V1 });
  });

  it('re-prompts after ops bump the version, and logs the new acceptance as a second row', async () => {
    const { id, email } = await makeMember('bump');
    const token = await loginOk(email);
    expect((await accept(token, V1)).status).toBe(200);

    await setSetting(SETTING_KEYS.termsCurrentVersion, V2);
    try {
      const mid = await profileTerms(token);
      expect(mid).toMatchObject({ currentVersion: V2, acceptedVersion: V1, needsAcceptance: true });

      // The old version is now stale even though this member accepted it once.
      expect((await accept(token, V1)).status).toBe(400);

      expect((await accept(token, V2)).status).toBe(200);
      expect((await profileTerms(token)).needsAcceptance).toBe(false);
      expect(await prisma.memberTermsAcceptance.count({ where: { memberId: id } })).toBe(2);
    } finally {
      await setSetting(SETTING_KEYS.termsCurrentVersion, V1);
    }
  });

  it('drops an unparseable x-platform header rather than storing it', async () => {
    const { id, email } = await makeMember('badhdr');
    const token = await loginOk(email);
    expect((await accept(token, V1, 'backfill:evil')).status).toBe(200);
    const row = await prisma.memberTermsAcceptance.findFirstOrThrow({ where: { memberId: id } });
    expect(row).toMatchObject({ platform: null, appVersion: null });
  });

  it('never flags anyone while the kill-switch is off, but still validates the version', async () => {
    const { email } = await makeMember('off');
    const token = await loginOk(email);
    await setSetting(SETTING_KEYS.termsEnabled, 'false');
    try {
      const terms = await profileTerms(token);
      expect(terms).toMatchObject({ enabled: false, acceptedVersion: null, needsAcceptance: false });
      expect((await accept(token, 'something-old')).status).toBe(400);
      expect((await accept(token, V1)).status).toBe(200);
    } finally {
      await setSetting(SETTING_KEYS.termsEnabled, 'true');
    }
  });
});
