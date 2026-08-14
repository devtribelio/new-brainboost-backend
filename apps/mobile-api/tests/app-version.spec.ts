import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { prisma } from '@bb/db';
import { env } from '@bb/common/config/env';
import { buildApp } from '../src/app';
import { AppVersionService } from '@/modules/app-version/app-version.service';

const app = buildApp();
const PATH = '/api/app/version-check';

async function setConfig(
  platform: string,
  data: {
    latestVersion: string;
    forceBelow?: string | null;
    softMessage?: string | null;
    forceMessage?: string | null;
    storeUrl?: string | null;
  },
) {
  await prisma.appVersionConfig.upsert({
    where: { platform },
    create: { platform, ...data },
    update: { forceBelow: null, softMessage: null, forceMessage: null, storeUrl: null, ...data },
  });
  // The service caches for 60s; tests rewrite the row between cases.
  AppVersionService.clearCache();
}

beforeEach(async () => {
  await prisma.appVersionConfig.deleteMany({ where: { platform: { in: ['android', 'ios'] } } });
  AppVersionService.clearCache();
});

afterAll(async () => {
  await prisma.appVersionConfig.deleteMany({ where: { platform: { in: ['android', 'ios'] } } });
  AppVersionService.clearCache();
});

describe('GET /api/app/version-check', () => {
  it('returns none (not an error) when the platform has no config row', async () => {
    const res = await request(app).get(PATH).query({ platform: 'ios', version: '1.0.0' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({
      update: 'none',
      latestVersion: null,
      storeUrl: null,
      message: null,
    });
  });

  it('force below the threshold, with the force copy', async () => {
    await setConfig('android', {
      latestVersion: '3.3.0',
      forceBelow: '3.2.0',
      softMessage: 'Versi baru sudah tersedia.',
      forceMessage: 'Update wajib untuk melanjutkan.',
    });

    const res = await request(app)
      .get(PATH)
      .query({ platform: 'android', version: '3.1.9', build: 180 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      update: 'force',
      latestVersion: '3.3.0',
      message: 'Update wajib untuk melanjutkan.',
    });
  });

  it('soft between the thresholds, with the soft copy', async () => {
    await setConfig('android', {
      latestVersion: '3.3.0',
      forceBelow: '3.2.0',
      softMessage: 'Versi baru sudah tersedia.',
      forceMessage: 'Update wajib untuk melanjutkan.',
    });

    const res = await request(app).get(PATH).query({ platform: 'android', version: '3.2.3' });
    expect(res.body.data).toMatchObject({
      update: 'soft',
      message: 'Versi baru sudah tersedia.',
    });
  });

  it('none on the latest version, and no message is leaked', async () => {
    await setConfig('android', {
      latestVersion: '3.3.0',
      forceBelow: '3.2.0',
      softMessage: 'Versi baru sudah tersedia.',
    });

    const res = await request(app).get(PATH).query({ platform: 'android', version: '3.3.0' });
    expect(res.body.data).toMatchObject({ update: 'none', message: null });
  });

  it('scopes the verdict per platform', async () => {
    await setConfig('android', { latestVersion: '3.3.0', forceBelow: '3.3.0' });
    await setConfig('ios', { latestVersion: '3.2.3', forceBelow: null });

    const android = await request(app).get(PATH).query({ platform: 'android', version: '3.2.3' });
    const ios = await request(app).get(PATH).query({ platform: 'ios', version: '3.2.3' });

    expect(android.body.data.update).toBe('force');
    expect(ios.body.data.update).toBe('none');
  });

  it('sends Cache-Control: no-store so the force kill-switch stays revocable', async () => {
    await setConfig('android', { latestVersion: '3.3.0' });
    const res = await request(app).get(PATH).query({ platform: 'android', version: '3.2.3' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  describe('auth tolerance (must never 401)', () => {
    beforeEach(async () => {
      await setConfig('android', { latestVersion: '3.3.0', forceBelow: '3.2.0' });
    });

    it('answers without any token', async () => {
      const res = await request(app).get(PATH).query({ platform: 'android', version: '3.1.0' });
      expect(res.status).toBe(200);
    });

    it('answers with an EXPIRED bearer instead of 401', async () => {
      // The client interceptor attaches whatever token it holds. A 401 here would kick
      // off a refresh / forced logout on nothing more than a version ping.
      const expired = jwt.sign({ sub: 'someone', typ: 'access' }, env.jwt.accessSecret, {
        expiresIn: '-1h',
      });
      const res = await request(app)
        .get(PATH)
        .set('Authorization', `Bearer ${expired}`)
        .query({ platform: 'android', version: '3.1.0' });

      expect(res.status).toBe(200);
      expect(res.body.data.update).toBe('force');
    });

    it('answers with a malformed bearer instead of 401', async () => {
      const res = await request(app)
        .get(PATH)
        .set('Authorization', 'Bearer not-a-jwt')
        .query({ platform: 'android', version: '3.1.0' });
      expect(res.status).toBe(200);
    });
  });

  describe('input handling', () => {
    beforeEach(async () => {
      await setConfig('android', { latestVersion: '3.3.0', forceBelow: '3.2.0' });
    });

    it('rejects an unknown platform', async () => {
      const res = await request(app).get(PATH).query({ platform: 'windows', version: '3.1.0' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a missing version', async () => {
      const res = await request(app).get(PATH).query({ platform: 'android' });
      expect(res.status).toBe(400);
    });

    it('answers none for an unparseable version rather than trapping the user', async () => {
      const res = await request(app).get(PATH).query({ platform: 'android', version: 'v3.1.0' });
      expect(res.status).toBe(200);
      expect(res.body.data.update).toBe('none');
    });

    it('does not require build', async () => {
      const res = await request(app).get(PATH).query({ platform: 'android', version: '3.1.0' });
      expect(res.status).toBe(200);
      expect(res.body.data.update).toBe('force');
    });
  });

  describe('DB guardrails', () => {
    it('rejects a non-semver version string', async () => {
      await expect(
        prisma.appVersionConfig.create({ data: { platform: 'ios', latestVersion: 'v3.3.0' } }),
      ).rejects.toThrow();
    });

    it('rejects forceBelow above latestVersion', async () => {
      await expect(
        prisma.appVersionConfig.create({
          data: { platform: 'ios', latestVersion: '3.3.0', forceBelow: '3.4.0' },
        }),
      ).rejects.toThrow();
    });

    it('allows forceBelow equal to latestVersion', async () => {
      await expect(
        prisma.appVersionConfig.create({
          data: { platform: 'ios', latestVersion: '3.3.0', forceBelow: '3.3.0' },
        }),
      ).resolves.toBeTruthy();
    });
  });
});
