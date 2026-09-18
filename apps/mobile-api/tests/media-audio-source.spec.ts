import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { buildApp } from '../src/app';
import { prisma } from '@bb/db';
import { signMediaToken, signAudioPlaylistToken } from '../src/modules/media/media-token.util';

/**
 * Integration tests for the single-file audio source.
 *
 * Runs in the default proxy mode (tests/setup.ts) on purpose: an asset that has
 * moved to our own storage must be served regardless of MEDIA_MODE, because it
 * never touches the Bunny library. The Bunny-only behaviour (404 in proxy mode
 * for a guid WITHOUT a row) is covered by media.spec.ts and must not change.
 */

const app: Express = buildApp();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PASSWORD = 'secret123';

const guidMoved = `guid-audio-moved-${suffix}`;
const guidInactive = `guid-audio-inactive-${suffix}`;
const guidBunny = `guid-audio-bunny-${suffix}`;

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

/** Follow the /hls answer to the playlist endpoint it points at. */
function playlistPath(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

beforeAll(async () => {
  enrolledEmail = `audio-src-enrolled-${suffix}@test.local`;
  strangerEmail = `audio-src-stranger-${suffix}@test.local`;

  const enrolled = await prisma.member.create({
    data: {
      email: enrolledEmail,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      fullName: 'Audio Source Enrolled',
      isEmailVerified: true,
    },
  });
  const stranger = await prisma.member.create({
    data: {
      email: strangerEmail,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      fullName: 'Audio Source Stranger',
      isEmailVerified: true,
    },
  });
  enrolledMemberId = enrolled.id;
  strangerMemberId = stranger.id;

  const product = await prisma.product.create({
    data: { type: 'course', title: `Audio Source Course ${suffix}`, price: 0, status: 'active' },
  });
  productId = product.id;
  const course = await prisma.course.create({ data: { productId } });
  courseId = course.id;
  await prisma.courseEnrollment.create({ data: { memberId: enrolledMemberId, courseId } });

  await prisma.mediaAudioSource.createMany({
    data: [
      {
        guid: guidMoved,
        audioKey: `audio/${guidMoved}/1.aac`,
        durationSec: 3123,
        bytes: 66_600_000,
        sha256: 'a'.repeat(64),
        encodedAt: new Date(),
      },
      {
        guid: guidInactive,
        audioKey: `audio/${guidInactive}/1.aac`,
        durationSec: 600,
        bytes: 12_000_000,
        sha256: 'b'.repeat(64),
        encodedAt: new Date(),
        isActive: false,
      },
    ],
  });
});

afterAll(async () => {
  await prisma.mediaAudioSource.deleteMany({ where: { guid: { in: [guidMoved, guidInactive] } } });
  await prisma.courseEnrollment.deleteMany({ where: { courseId } });
  await prisma.course.deleteMany({ where: { id: courseId } });
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.refreshToken.deleteMany({
    where: { memberId: { in: [enrolledMemberId, strangerMemberId] } },
  });
  await prisma.member.deleteMany({ where: { id: { in: [enrolledMemberId, strangerMemberId] } } });
  await prisma.$disconnect();
});

describe('GET /api/member/media/hls for an asset moved to our storage', () => {
  it('preview token → 200 with a playlist URL on this backend, even in proxy mode', async () => {
    const token = signMediaToken({ guid: guidMoved, courseId, isPreview: true });
    const res = await request(app).get('/api/member/media/hls').query({ t: token });

    expect(res.status).toBe(200);
    const { url, expiresAt, guid } = res.body.data;
    expect(guid).toBe(guidMoved);
    expect(url).toContain('/api/member/media/audio-playlist?t=');
    expect(url).not.toContain('b-cdn.net');
    expect(typeof expiresAt).toBe('number');
    expect(expiresAt * 1000).toBeGreaterThan(Date.now());
  });

  it('an INACTIVE row is Bunny as before → 404 in proxy mode (rollback per asset)', async () => {
    const token = signMediaToken({ guid: guidInactive, courseId, isPreview: true });
    const res = await request(app).get('/api/member/media/hls').query({ t: token });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('MEDIA_HLS_UNAVAILABLE');
  });

  it('a guid with no row is Bunny as before → 404 in proxy mode', async () => {
    const token = signMediaToken({ guid: guidBunny, courseId, isPreview: true });
    const res = await request(app).get('/api/member/media/hls').query({ t: token });
    expect(res.status).toBe(404);
  });

  it('non-preview token, authed and enrolled → 200', async () => {
    const access = await loginToken(enrolledEmail);
    const token = signMediaToken({ guid: guidMoved, courseId, isPreview: false });
    const res = await request(app)
      .get('/api/member/media/hls')
      .query({ t: token })
      .set('Authorization', `Bearer ${access}`);
    expect(res.status).toBe(200);
    expect(res.body.data.url).toContain('/media/audio-playlist?t=');
  });

  // The gate is unchanged by the source: a moved asset must not become public.
  it('non-preview token, not enrolled → 403; without auth → 401', async () => {
    const access = await loginToken(strangerEmail);
    const token = signMediaToken({ guid: guidMoved, courseId, isPreview: false });
    const forbidden = await request(app)
      .get('/api/member/media/hls')
      .query({ t: token })
      .set('Authorization', `Bearer ${access}`);
    expect(forbidden.status).toBe(403);

    const anonymous = await request(app).get('/api/member/media/hls').query({ t: token });
    expect(anonymous.status).toBe(401);
  });

  it('download=true yields a later expiry than streaming', async () => {
    const token = signMediaToken({ guid: guidMoved, courseId, isPreview: true });
    const stream = await request(app).get('/api/member/media/hls').query({ t: token });
    const download = await request(app)
      .get('/api/member/media/hls')
      .query({ t: token, download: 'true' });
    expect(download.body.data.expiresAt).toBeGreaterThan(stream.body.data.expiresAt);
  });
});

describe('GET /api/member/media/audio-playlist', () => {
  it('serves a one-segment m3u8 with a presigned URL for the row key, no bearer needed', async () => {
    const token = signMediaToken({ guid: guidMoved, courseId, isPreview: true });
    const hls = await request(app).get('/api/member/media/hls').query({ t: token });
    expect(hls.status).toBe(200);

    const res = await request(app).get(playlistPath(hls.body.data.url));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/vnd.apple.mpegurl');
    expect(res.headers['cache-control']).toBe('no-store');

    const body = res.text;
    expect(body.startsWith('#EXTM3U')).toBe(true);
    expect(body).toContain('#EXT-X-TARGETDURATION:3123');
    expect(body.match(/#EXTINF/g)).toHaveLength(1);
    expect(body).toContain(`audio/${guidMoved}/1.aac`);
    expect(body).toContain('X-Amz-Signature');
    expect(body).toContain('#EXT-X-ENDLIST');
  });

  it('a media token is not accepted here → 401', async () => {
    const token = signMediaToken({ guid: guidMoved, courseId, isPreview: true });
    const res = await request(app).get('/api/member/media/audio-playlist').query({ t: token });
    expect(res.status).toBe(401);
  });

  it('missing token → 400', async () => {
    const res = await request(app).get('/api/member/media/audio-playlist');
    expect(res.status).toBe(400);
  });

  // Rolled back between /hls and the fetch: the playlist must fail rather
  // than sign a URL for an object that may no longer exist.
  it('a playlist token for an inactive asset → 404', async () => {
    const token = signAudioPlaylistToken(
      { guid: guidInactive, courseId, isPreview: true, forDownload: false },
      60,
    );
    const res = await request(app).get('/api/member/media/audio-playlist').query({ t: token });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('MEDIA_HLS_UNAVAILABLE');
  });
});
