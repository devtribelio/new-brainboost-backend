import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app';
import { prisma } from '@bb/db';
import * as bcrypt from 'bcryptjs';

/**
 * Integration tests for the `isSubscribe` filter on GET /api/member/topic/list.
 *
 * Real Postgres. Topics are seeded with a unique keyword prefix so the list
 * can be scoped to this suite's rows via the existing `keyword` filter.
 */

const app = buildApp();

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const KEYWORD = `TopicFilter-${suffix}`;
const PASSWORD = 'secret123';

let memberId: string;
let memberEmail: string;
let subscribedTopicId: string;
let otherTopicIds: string[] = [];
let accessToken: string;

const listUrl = (extra = '') => `/api/member/topic/list?keyword=${KEYWORD}${extra}`;

beforeAll(async () => {
  memberEmail = `topic-filter-${suffix}@test.local`;
  const member = await prisma.member.create({
    data: {
      email: memberEmail,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      fullName: 'Topic Filter Tester',
      isEmailVerified: true,
    },
  });
  memberId = member.id;

  const [a, b, c] = await Promise.all(
    ['A', 'B', 'C'].map((n) => prisma.topic.create({ data: { name: `${KEYWORD} ${n}` } })),
  );
  subscribedTopicId = a.id;
  otherTopicIds = [b.id, c.id];

  await prisma.topicSubscription.create({ data: { memberId, topicId: subscribedTopicId } });

  const res = await request(app)
    .post('/api/member/oauth/token')
    .send({ grant_type: 'password', username: memberEmail, password: PASSWORD });
  expect(res.status).toBe(200);
  accessToken = res.body.data.access_token as string;
});

afterAll(async () => {
  const topicIds = [subscribedTopicId, ...otherTopicIds];
  await prisma.topicSubscription.deleteMany({ where: { topicId: { in: topicIds } } });
  await prisma.topic.deleteMany({ where: { id: { in: topicIds } } });
  await prisma.member.deleteMany({ where: { id: memberId } });
});

describe('GET /api/member/topic/list isSubscribe filter', () => {
  it('isSubscribe=true returns only subscribed topics with matching total', async () => {
    const res = await request(app)
      .get(listUrl('&isSubscribe=true'))
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(subscribedTopicId);
    expect(res.body.data[0].isSubscribeTopic).toBe(true);
    expect(res.body.meta.pagination.total).toBe(1);
  });

  it('isSubscribe=false returns only unsubscribed topics with matching total', async () => {
    const res = await request(app)
      .get(listUrl('&isSubscribe=false'))
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((t: { id: string }) => t.id).sort();
    expect(ids).toEqual([...otherTopicIds].sort());
    for (const row of res.body.data) expect(row.isSubscribeTopic).toBe(false);
    expect(res.body.meta.pagination.total).toBe(2);
  });

  it('isSubscribe=1 is accepted as true', async () => {
    const res = await request(app)
      .get(listUrl('&isSubscribe=1'))
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(subscribedTopicId);
  });

  it('omitting the filter lists all topics, decorated per row', async () => {
    const res = await request(app)
      .get(listUrl())
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    const byId = new Map(
      res.body.data.map((t: { id: string; isSubscribeTopic: boolean }) => [t.id, t]),
    );
    expect((byId.get(subscribedTopicId) as { isSubscribeTopic: boolean }).isSubscribeTopic).toBe(
      true,
    );
    for (const id of otherTopicIds) {
      expect((byId.get(id) as { isSubscribeTopic: boolean }).isSubscribeTopic).toBe(false);
    }
  });

  it('anonymous + isSubscribe=true → empty list', async () => {
    const res = await request(app).get(listUrl('&isSubscribe=true'));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.meta.pagination.total).toBe(0);
  });

  it('anonymous + isSubscribe=false → full list (subscribed-to-nothing semantics)', async () => {
    const res = await request(app).get(listUrl('&isSubscribe=false'));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
  });
});
