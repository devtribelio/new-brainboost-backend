import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';

/**
 * Integration tests for the media endpoint in **signed mode (Model C)**.
 *
 * `MEDIA_MODE` is read by `env.ts` at import time, so it must be set BEFORE the
 * app (and `env.ts`) load — hence the env writes here run before the dynamic
 * imports in `beforeAll`. Vitest isolates the module registry per test file, so
 * this does not affect the proxy-mode suite in `media.spec.ts`.
 */

const ORIG = {
  MEDIA_MODE: process.env.MEDIA_MODE,
  BUNNY_STREAM_TOKEN_KEY: process.env.BUNNY_STREAM_TOKEN_KEY,
  BUNNY_STREAM_CDN_HOST: process.env.BUNNY_STREAM_CDN_HOST,
};
let app: Express;
let prisma: typeof import('@bb/db').prisma;
let signMediaToken: typeof import('../src/modules/media/media-token.util').signMediaToken;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PASSWORD = 'secret123';

let courseId: string;
let productId: string;
let enrolledEmail: string;
let strangerEmail: string;
let enrolledMemberId: string;
let strangerMemberId: string;

async function loginToken(email: string): Promise<string> {
  const res = await request(app)
    .post('/api/member/oauth/token')
    .send({ grant_type: 'password', username: email, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data.access_token as string;
}

beforeAll(async () => {
  // Set the mode BEFORE the dynamic imports load env.ts. Kept out of module
  // top-level so test collection does not pollute process.env for other suites.
  process.env.MEDIA_MODE = 'signed';
  process.env.BUNNY_STREAM_TOKEN_KEY = 'test-signing-key-abc';
  process.env.BUNNY_STREAM_CDN_HOST = 'vz-test-c.b-cdn.net';

  app = (await import('../src/app')).buildApp();
  prisma = (await import('@bb/db')).prisma;
  signMediaToken = (await import('../src/modules/media/media-token.util')).signMediaToken;

  enrolledEmail = `media-c-enrolled-${suffix}@test.local`;
  strangerEmail = `media-c-stranger-${suffix}@test.local`;

  const enrolled = await prisma.member.create({
    data: {
      email: enrolledEmail,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      fullName: 'Media C Enrolled',
      isVerified: true,
    },
  });
  const stranger = await prisma.member.create({
    data: {
      email: strangerEmail,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      fullName: 'Media C Stranger',
      isVerified: true,
    },
  });
  enrolledMemberId = enrolled.id;
  strangerMemberId = stranger.id;

  const product = await prisma.product.create({
    data: { type: 'course', title: `Media C Course ${suffix}`, price: 0, status: 'active' },
  });
  productId = product.id;

  const course = await prisma.course.create({ data: { productId } });
  courseId = course.id;

  await prisma.courseEnrollment.create({ data: { memberId: enrolledMemberId, courseId } });
});

afterAll(async () => {
  await prisma.courseEnrollment.deleteMany({ where: { courseId } });
  await prisma.course.deleteMany({ where: { id: courseId } });
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.refreshToken.deleteMany({
    where: { memberId: { in: [enrolledMemberId, strangerMemberId] } },
  });
  await prisma.member.deleteMany({
    where: { id: { in: [enrolledMemberId, strangerMemberId] } },
  });
  await prisma.$disconnect();

  // Restore env so a later suite in the same worker is not left in signed mode.
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('GET /api/member/media/stream (signed mode / Model C)', () => {
  it('preview token → 302 redirect to a signed Bunny URL', async () => {
    const token = signMediaToken({ guid: 'guid-c-preview', courseId, isPreview: true });
    const res = await request(app)
      .get('/api/member/media/stream')
      .query({ t: token })
      .redirects(0);

    expect(res.status).toBe(302);
    const loc = res.headers.location as string;
    expect(loc).toContain('vz-test-c.b-cdn.net');
    expect(loc).toContain('/bcdn_token=HS256-');
    expect(loc).toContain('token_path=%2Fguid-c-preview%2F');
    expect(loc).toMatch(/&expires=\d+/);
    expect(loc.endsWith('/guid-c-preview/playlist.m3u8')).toBe(true);
  });

  it('non-preview token, authed and enrolled → 302 redirect', async () => {
    const access = await loginToken(enrolledEmail);
    const token = signMediaToken({ guid: 'guid-c-gated', courseId, isPreview: false });
    const res = await request(app)
      .get('/api/member/media/stream')
      .query({ t: token })
      .set('Authorization', `Bearer ${access}`)
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/guid-c-gated/playlist.m3u8');
  });

  it('non-preview token, authed but not enrolled → 403 (no redirect)', async () => {
    const access = await loginToken(strangerEmail);
    const token = signMediaToken({ guid: 'guid-c-gated', courseId, isPreview: false });
    const res = await request(app)
      .get('/api/member/media/stream')
      .query({ t: token })
      .set('Authorization', `Bearer ${access}`)
      .redirects(0);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('non-preview token without auth → 401 (no redirect)', async () => {
    const token = signMediaToken({ guid: 'guid-c-gated', courseId, isPreview: false });
    const res = await request(app)
      .get('/api/member/media/stream')
      .query({ t: token })
      .redirects(0);

    expect(res.status).toBe(401);
  });

  it('malformed token → 401', async () => {
    const res = await request(app)
      .get('/api/member/media/stream')
      .query({ t: 'totally-bogus-token' })
      .redirects(0);

    expect(res.status).toBe(401);
  });
});
