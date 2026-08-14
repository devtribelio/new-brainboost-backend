import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { buildApp } from '../src/app';
import { prisma } from '@bb/db';

/**
 * GET /api/member/topic/detail — hydrates the topic screen after a `topicDigest`
 * push deep link. Real Postgres.
 */

const app = buildApp();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PASSWORD = 'secret123';

let memberId = '';
let accessToken = '';
let topicId = '';
let topicLegacyId = 0;
let inactiveTopicId = '';
let authorId = '';
let postIds: string[] = [];

const detailUrl = (id: string) => `/api/member/topic/detail?topicId=${id}`;

beforeAll(async () => {
  const email = `topic-detail-${suffix}@test.local`;
  const member = await prisma.member.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      fullName: 'Topic Detail Tester',
      isEmailVerified: true,
    },
  });
  memberId = member.id;
  authorId = memberId;

  topicLegacyId = 900_000_000 + Math.floor(Math.random() * 1_000_000);
  const topic = await prisma.topic.create({
    data: {
      name: `Detail Topic ${suffix}`,
      legacyId: topicLegacyId,
      description: 'Topik untuk tes detail',
      iconType: 'emoji',
    },
  });
  topicId = topic.id;

  const inactive = await prisma.topic.create({
    data: { name: `Inactive Topic ${suffix}`, isActive: false },
  });
  inactiveTopicId = inactive.id;

  // 2 published + 1 deleted + 1 draft → countPost must report 2.
  const rows = await Promise.all([
    prisma.post.create({
      data: { authorId, topicId, content: 'a', publishStatus: 'PUBLISHED' },
    }),
    prisma.post.create({
      data: { authorId, topicId, content: 'b', publishStatus: 'PUBLISHED' },
    }),
    prisma.post.create({
      data: { authorId, topicId, content: 'c', publishStatus: 'PUBLISHED', isDeleted: true },
    }),
    prisma.post.create({
      data: { authorId, topicId, content: 'd', publishStatus: 'DRAFT' },
    }),
  ]);
  postIds = rows.map((r) => r.id);

  const res = await request(app)
    .post('/api/member/oauth/token')
    .send({ grant_type: 'password', username: email, password: PASSWORD });
  expect(res.status).toBe(200);
  accessToken = res.body.data.access_token as string;
});

afterAll(async () => {
  await prisma.post.deleteMany({ where: { id: { in: postIds } } });
  await prisma.notificationMute.deleteMany({ where: { memberId } });
  await prisma.topicSubscription.deleteMany({ where: { topicId } });
  await prisma.topic.deleteMany({ where: { id: { in: [topicId, inactiveTopicId] } } });
  await prisma.member.deleteMany({ where: { id: memberId } });
});

describe('GET /api/member/topic/detail', () => {
  it('returns the topic by uuid', async () => {
    const res = await request(app).get(detailUrl(topicId)).expect(200);
    expect(res.body.data.id).toBe(topicId);
    expect(res.body.data.name).toBe(`Detail Topic ${suffix}`);
    expect(res.body.data.iconType).toBe('emoji');
  });

  it('accepts the legacyId int too', async () => {
    const res = await request(app).get(detailUrl(String(topicLegacyId))).expect(200);
    expect(res.body.data.id).toBe(topicId);
  });

  it('counts only published, non-deleted posts', async () => {
    const res = await request(app).get(detailUrl(topicId)).expect(200);
    expect(res.body.data.countPost).toBe(2);
  });

  it('resolves subscribe + mute for the authenticated caller', async () => {
    const anon = await request(app).get(detailUrl(topicId)).expect(200);
    expect(anon.body.data.isSubscribeTopic).toBe(false);
    expect(anon.body.data.isMute).toBe(false);

    await request(app)
      .post('/api/member/topic/subscribe')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ topicId, action: 'subscribe' })
      .expect(200);
    await request(app)
      .post('/api/member/notification/mute')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ scope: 'topic', refId: topicId })
      .expect(200);

    const authed = await request(app)
      .get(detailUrl(topicId))
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(authed.body.data.isSubscribeTopic).toBe(true);
    expect(authed.body.data.isMute).toBe(true);
  });

  it('404s on an unknown topic — the deep link needs to tell "gone" from "malformed"', async () => {
    const res = await request(app)
      .get(detailUrl('019fc67e-dead-7000-8000-000000000000'))
      .expect(404);
    expect(res.body.error.code).toBe('TOPIC_NOT_FOUND');
  });

  it('404s on an inactive topic', async () => {
    const res = await request(app).get(detailUrl(inactiveTopicId)).expect(404);
    expect(res.body.error.code).toBe('TOPIC_NOT_FOUND');
  });

  it('400s when topicId is missing', async () => {
    const res = await request(app).get('/api/member/topic/detail').expect(400);
    expect(res.body.error.code).toBe('TOPIC_ID_REQUIRED');
  });

  it('400s on a malformed topicId rather than a Prisma 500', async () => {
    const res = await request(app).get(detailUrl('not-a-uuid')).expect(400);
    expect(res.body.error.code).toBe('ID_FORMAT_INVALID');
  });
});
