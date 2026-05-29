import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import request from 'supertest';
import { buildApp } from '../src/app';
import { prisma } from '@bb/db';
import { signMediaToken } from '../src/modules/media/media-token.util';
import * as bcrypt from 'bcryptjs';

/**
 * Integration tests for the media proxy.
 *
 * Real Postgres for the DB (course + enrollment rows). The only mock is the
 * Bunny upstream — `global.fetch` is stubbed so no real CDN call is made.
 */

const app = buildApp();
const realFetch = global.fetch;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PASSWORD = 'secret123';

let courseId: string;
let productId: string;
let enrolledEmail: string;
let strangerEmail: string;
let enrolledMemberId: string;
let strangerMemberId: string;

/** Build a fake Bunny upstream Response with a streamed MP4 body. */
function fakeUpstream(opts: {
  status: number;
  body?: Buffer | null;
  headers?: Record<string, string>;
}): Response {
  const headers = new Headers({ 'content-type': 'video/mp4', ...(opts.headers ?? {}) });
  const body =
    opts.body === null || opts.body === undefined
      ? null
      : (Readable.toWeb(Readable.from(opts.body)) as ReadableStream);
  return new Response(body, { status: opts.status, headers });
}

async function loginToken(email: string): Promise<string> {
  const res = await request(app)
    .post('/api/member/oauth/token')
    .send({ grant_type: 'password', username: email, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data.access_token as string;
}

beforeAll(async () => {
  enrolledEmail = `media-enrolled-${suffix}@test.local`;
  strangerEmail = `media-stranger-${suffix}@test.local`;

  const enrolled = await prisma.member.create({
    data: {
      email: enrolledEmail,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      fullName: 'Media Enrolled',
      isVerified: true,
    },
  });
  const stranger = await prisma.member.create({
    data: {
      email: strangerEmail,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      fullName: 'Media Stranger',
      isVerified: true,
    },
  });
  enrolledMemberId = enrolled.id;
  strangerMemberId = stranger.id;

  const product = await prisma.product.create({
    data: { type: 'course', title: `Media Course ${suffix}`, price: 0, status: 'active' },
  });
  productId = product.id;

  const course = await prisma.course.create({ data: { productId } });
  courseId = course.id;

  await prisma.courseEnrollment.create({
    data: { memberId: enrolledMemberId, courseId },
  });
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
});

beforeEach(() => {
  global.fetch = realFetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  global.fetch = realFetch;
});

describe('GET /api/member/media/stream', () => {
  it('preview token streams the upstream body (200)', async () => {
    const mp4 = Buffer.from('FAKE-MP4-PREVIEW-BYTES');
    global.fetch = vi.fn().mockResolvedValue(
      fakeUpstream({ status: 200, body: mp4, headers: { 'content-length': String(mp4.length) } }),
    ) as unknown as typeof fetch;

    const token = signMediaToken({ guid: 'guid-preview', courseId, isPreview: true });
    const res = await request(app).get('/api/member/media/stream').query({ t: token });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('video/mp4');
    expect(Buffer.from(res.body).toString()).toBe('FAKE-MP4-PREVIEW-BYTES');
  });

  it('preview token forwards no Range and works anonymously', async () => {
    const spy = vi.fn().mockResolvedValue(fakeUpstream({ status: 200, body: Buffer.from('x') }));
    global.fetch = spy as unknown as typeof fetch;

    const token = signMediaToken({ guid: 'guid-preview-2', courseId, isPreview: true });
    const res = await request(app).get('/api/member/media/stream').query({ t: token });

    expect(res.status).toBe(200);
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Range).toBeUndefined();
  });

  it('forwards a Range header → 206 with content-range', async () => {
    const spy = vi.fn().mockResolvedValue(
      fakeUpstream({
        status: 206,
        body: Buffer.from('PARTIAL'),
        headers: { 'content-range': 'bytes 0-6/100', 'accept-ranges': 'bytes' },
      }),
    );
    global.fetch = spy as unknown as typeof fetch;

    const token = signMediaToken({ guid: 'guid-range', courseId, isPreview: true });
    const res = await request(app)
      .get('/api/member/media/stream')
      .query({ t: token })
      .set('Range', 'bytes=0-6');

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 0-6/100');
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Range).toBe('bytes=0-6');
  });

  it('non-preview token without auth → 401', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      fakeUpstream({ status: 200, body: Buffer.from('x') }),
    ) as unknown as typeof fetch;

    const token = signMediaToken({ guid: 'guid-gated', courseId, isPreview: false });
    const res = await request(app).get('/api/member/media/stream').query({ t: token });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('non-preview token, authed but not enrolled → 403', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      fakeUpstream({ status: 200, body: Buffer.from('x') }),
    ) as unknown as typeof fetch;

    const access = await loginToken(strangerEmail);
    const token = signMediaToken({ guid: 'guid-gated', courseId, isPreview: false });
    const res = await request(app)
      .get('/api/member/media/stream')
      .query({ t: token })
      .set('Authorization', `Bearer ${access}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('non-preview token, authed and enrolled → 200 streamed', async () => {
    const mp4 = Buffer.from('FAKE-MP4-ENROLLED-BYTES');
    global.fetch = vi.fn().mockResolvedValue(
      fakeUpstream({ status: 200, body: mp4 }),
    ) as unknown as typeof fetch;

    const access = await loginToken(enrolledEmail);
    const token = signMediaToken({ guid: 'guid-gated', courseId, isPreview: false });
    const res = await request(app)
      .get('/api/member/media/stream')
      .query({ t: token })
      .set('Authorization', `Bearer ${access}`);

    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).toString()).toBe('FAKE-MP4-ENROLLED-BYTES');
  });

  it('malformed token → 401', async () => {
    const res = await request(app)
      .get('/api/member/media/stream')
      .query({ t: 'totally-bogus-token' });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('missing token → 400', async () => {
    const res = await request(app).get('/api/member/media/stream');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('upstream 404 is collapsed to a plain 404 (no Bunny leak)', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      fakeUpstream({ status: 404, body: null }),
    ) as unknown as typeof fetch;

    const token = signMediaToken({ guid: 'guid-missing', courseId, isPreview: true });
    const res = await request(app).get('/api/member/media/stream').query({ t: token });

    expect(res.status).toBe(404);
  });

  it('HEAD probe relays status + headers without a body', async () => {
    const spy = vi.fn().mockResolvedValue(
      fakeUpstream({
        status: 200,
        body: Buffer.from('SHOULD-NOT-BE-SENT'),
        headers: { 'content-length': '12345', 'accept-ranges': 'bytes' },
      }),
    );
    global.fetch = spy as unknown as typeof fetch;

    const token = signMediaToken({ guid: 'guid-head', courseId, isPreview: true });
    const res = await request(app).head('/api/member/media/stream').query({ t: token });

    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe('12345');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.body).toEqual({});
  });
});

describe('GET /api/member/media/download', () => {
  it('preview token → 302 redirect to a signed Bunny MP4', async () => {
    const token = signMediaToken({ guid: 'guid-dl-preview', courseId, isPreview: true });
    const res = await request(app)
      .get('/api/member/media/download')
      .query({ t: token })
      .redirects(0);

    expect(res.status).toBe(302);
    const loc = res.headers.location as string;
    expect(loc).toContain('/guid-dl-preview/play_');
    expect(loc).toContain('.mp4');
    expect(loc).toContain('?token=HS256-');
    expect(loc).toMatch(/&expires=\d+/);
    // Single-file form — not a directory token.
    expect(loc).not.toContain('/bcdn_token=');
  });

  it('sets Content-Disposition: attachment with a sanitised filename override', async () => {
    const token = signMediaToken({ guid: 'guid-dl-name', courseId, isPreview: true });
    const withCustom = await request(app)
      .get('/api/member/media/download')
      .query({ t: token, filename: 'Brain Boost / Trauma <Audio>.mp4' })
      .redirects(0);
    expect(withCustom.status).toBe(302);
    // Slashes + angle brackets stripped; rest preserved.
    expect(withCustom.headers['content-disposition']).toBe(
      'attachment; filename="Brain Boost  Trauma Audio.mp4"',
    );

    const noOverride = await request(app)
      .get('/api/member/media/download')
      .query({ t: token })
      .redirects(0);
    expect(noOverride.status).toBe(302);
    expect(noOverride.headers['content-disposition']).toBe(
      'attachment; filename="media-guid-dl-name.mp4"',
    );
  });

  it('honours the res query param', async () => {
    const token = signMediaToken({ guid: 'guid-dl-res', courseId, isPreview: true });
    const res = await request(app)
      .get('/api/member/media/download')
      .query({ t: token, res: '360p' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location as string).toContain('/guid-dl-res/play_360p.mp4');
  });

  it('non-preview token without auth → 401', async () => {
    const token = signMediaToken({ guid: 'guid-dl-gated', courseId, isPreview: false });
    const res = await request(app)
      .get('/api/member/media/download')
      .query({ t: token })
      .redirects(0);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('non-preview token, authed but not enrolled → 403', async () => {
    const access = await loginToken(strangerEmail);
    const token = signMediaToken({ guid: 'guid-dl-gated', courseId, isPreview: false });
    const res = await request(app)
      .get('/api/member/media/download')
      .query({ t: token })
      .set('Authorization', `Bearer ${access}`)
      .redirects(0);

    expect(res.status).toBe(403);
  });

  it('non-preview token, authed and enrolled → 302', async () => {
    const access = await loginToken(enrolledEmail);
    const token = signMediaToken({ guid: 'guid-dl-gated', courseId, isPreview: false });
    const res = await request(app)
      .get('/api/member/media/download')
      .query({ t: token })
      .set('Authorization', `Bearer ${access}`)
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location as string).toContain('/guid-dl-gated/play_');
  });

  it('malformed token → 401', async () => {
    const res = await request(app)
      .get('/api/member/media/download')
      .query({ t: 'totally-bogus-token' })
      .redirects(0);
    expect(res.status).toBe(401);
  });

  it('missing token → 400', async () => {
    const res = await request(app).get('/api/member/media/download').redirects(0);
    expect(res.status).toBe(400);
  });
});
