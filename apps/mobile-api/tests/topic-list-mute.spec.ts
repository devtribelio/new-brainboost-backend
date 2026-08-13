import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app';
import { prisma } from '@bb/db';
import * as bcrypt from 'bcryptjs';

/**
 * `isMute` on GET /api/member/topic/list — per-member mute state so the FE can
 * render the bell toggle without a second request. Real Postgres.
 */

const app = buildApp();

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const KEYWORD = `TopicMute-${suffix}`;
const PASSWORD = 'secret123';

let memberId: string;
let mutedTopicId: string;
let plainTopicId: string;
let mutedAndSubscribedId: string;
let accessToken: string;

const listUrl = (extra = '') => `/api/member/topic/list?keyword=${KEYWORD}${extra}`;

function rowsById(body: { data: Array<{ id: string; isMute: boolean; isSubscribeTopic: boolean }> }) {
  return new Map(body.data.map((t) => [t.id, t]));
}

beforeAll(async () => {
  const email = `topic-mute-${suffix}@test.local`;
  const member = await prisma.member.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      fullName: 'Topic Mute Tester',
      isEmailVerified: true,
    },
  });
  memberId = member.id;

  const [a, b, c] = await Promise.all(
    ['A', 'B', 'C'].map((n) => prisma.topic.create({ data: { name: `${KEYWORD} ${n}` } })),
  );
  mutedTopicId = a.id;
  plainTopicId = b.id;
  mutedAndSubscribedId = c.id;

  // Muted but NOT subscribed — mute must be independent of subscription.
  await prisma.notificationMute.create({
    data: { memberId, scope: 'topic', refId: mutedTopicId },
  });
  await prisma.notificationMute.create({
    data: { memberId, scope: 'topic', refId: mutedAndSubscribedId },
  });
  await prisma.topicSubscription.create({ data: { memberId, topicId: mutedAndSubscribedId } });

  const res = await request(app)
    .post('/api/member/oauth/token')
    .send({ grant_type: 'password', username: email, password: PASSWORD });
  expect(res.status).toBe(200);
  accessToken = res.body.data.access_token as string;
});

afterAll(async () => {
  const topicIds = [mutedTopicId, plainTopicId, mutedAndSubscribedId];
  await prisma.notificationMute.deleteMany({ where: { memberId } });
  await prisma.topicSubscription.deleteMany({ where: { topicId: { in: topicIds } } });
  await prisma.topic.deleteMany({ where: { id: { in: topicIds } } });
  await prisma.member.deleteMany({ where: { id: memberId } });
});

describe('GET /api/member/topic/list isMute', () => {
  it('flags muted topics per row', async () => {
    const res = await request(app).get(listUrl()).set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    const byId = rowsById(res.body);
    expect(byId.get(mutedTopicId)!.isMute).toBe(true);
    expect(byId.get(plainTopicId)!.isMute).toBe(false);
  });

  it('is independent of subscription state', async () => {
    const res = await request(app).get(listUrl()).set('Authorization', `Bearer ${accessToken}`);
    const byId = rowsById(res.body);
    // Muted without being subscribed.
    expect(byId.get(mutedTopicId)!.isSubscribeTopic).toBe(false);
    expect(byId.get(mutedTopicId)!.isMute).toBe(true);
    // Both at once.
    expect(byId.get(mutedAndSubscribedId)!.isSubscribeTopic).toBe(true);
    expect(byId.get(mutedAndSubscribedId)!.isMute).toBe(true);
  });

  it('is still set on the isSubscribe-filtered path', async () => {
    const res = await request(app)
      .get(listUrl('&isSubscribe=true'))
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(mutedAndSubscribedId);
    expect(res.body.data[0].isMute).toBe(true);
  });

  it('reflects an unmute', async () => {
    await request(app)
      .post('/api/member/notification/unmute')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ scope: 'topic', refId: mutedTopicId })
      .expect(200);

    const res = await request(app).get(listUrl()).set('Authorization', `Bearer ${accessToken}`);
    expect(rowsById(res.body).get(mutedTopicId)!.isMute).toBe(false);

    // Put it back so the other assertions stay order-independent.
    await request(app)
      .post('/api/member/notification/mute')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ scope: 'topic', refId: mutedTopicId })
      .expect(200);
  });

  it('is false for anonymous callers', async () => {
    const res = await request(app).get(listUrl());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    for (const row of res.body.data) expect(row.isMute).toBe(false);
  });
});
