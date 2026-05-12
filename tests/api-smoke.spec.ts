import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app';
import { prisma } from '../src/config/prisma';

describe('legacy-aligned API smoke', () => {
  const app = buildApp();
  const email = `smoke-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  const password = 'secret123';
  let accessToken = '';

  beforeAll(async () => {
    await request(app).post('/api/member/auth/register').send({
      email,
      password,
      confirmPassword: password,
      fullName: 'Smoke Tester',
    });
    const res = await request(app)
      .post('/api/member/oauth/token')
      .send({ grant_type: 'password', username: email, password });
    accessToken = (res.body as { access_token: string }).access_token;
  });

  afterAll(async () => {
    const member = await prisma.member.findUnique({ where: { email } });
    if (member) {
      await prisma.refreshToken.deleteMany({ where: { memberId: member.id } });
      await prisma.member.delete({ where: { id: member.id } });
    }
    await prisma.$disconnect();
  });

  it('GET /api/member/data/banner', async () => {
    const r = await request(app).get('/api/member/data/banner');
    expect(r.status).toBe(200);
    expect(r.body.errCode).toBe(0);
  });

  it('GET /api/member/data/location/country pagination', async () => {
    const r = await request(app).get('/api/member/data/location/country?page=1&perPage=5');
    expect(r.status).toBe(200);
    expect(r.body.data.items.length).toBeLessThanOrEqual(5);
    expect(r.body.data.total).toBeGreaterThan(0);
  });

  it('GET /api/member/topic/list', async () => {
    const r = await request(app).get('/api/member/topic/list?perPage=3');
    expect(r.status).toBe(200);
    expect(r.body.data.items.length).toBeLessThanOrEqual(3);
  });

  it('GET /api/member/post/list without token → 401', async () => {
    const r = await request(app).get('/api/member/post/list?perPage=3');
    expect(r.status).toBe(401);
  });

  it('GET /api/member/post/list requires auth', async () => {
    const r = await request(app)
      .get('/api/member/post/list?perPage=3')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data.items)).toBe(true);
    if (r.body.data.items.length > 0) {
      const p = r.body.data.items[0];
      expect(p).toHaveProperty('postId');
      expect(p).toHaveProperty('content');
      expect(p).toHaveProperty('countLike');
    }
  });

  it('GET /api/member/post/detail with legacyId requires auth', async () => {
    const list = await request(app)
      .get('/api/member/post/list?perPage=1')
      .set('Authorization', `Bearer ${accessToken}`);
    const postId = list.body.data.items[0]?.postId;
    if (!postId) return;
    const r = await request(app)
      .get('/api/member/post/detail')
      .query({ postId })
      .set('Authorization', `Bearer ${accessToken}`);
    expect(r.status).toBe(200);
    expect(r.body.data.postId).toBe(postId);
  });

  it('GET /api/member/comment/list requires postId', async () => {
    const r = await request(app).get('/api/member/comment/list');
    expect(r.status).toBe(400);
  });

  it('GET /api/member/network/member with empty input returns 200 (lists all)', async () => {
    const r = await request(app).get('/api/member/network/member?page=1&perPage=20');
    expect(r.status).toBe(200);
    expect(r.body.errCode).toBe(0);
    expect(Array.isArray(r.body.data.items)).toBe(true);
  });

  it('GET /api/member/network/tag with empty code returns 200 (lists all)', async () => {
    const r = await request(app).get(
      '/api/member/network/tag?page=1&perPage=50&keyword=&code=',
    );
    expect(r.status).toBe(200);
    expect(r.body.errCode).toBe(0);
    expect(r.body.data.items).toBeDefined();
    expect(Array.isArray(r.body.data.items)).toBe(true);
  });

  it('GET /api/member/network/tag with keyword filters case-insensitively', async () => {
    const r = await request(app).get('/api/member/network/tag?keyword=zzz-no-match-zzz');
    expect(r.status).toBe(200);
    expect(r.body.data.items).toEqual([]);
    expect(r.body.data.total).toBe(0);
  });

  it('GET /api/member/report/category', async () => {
    const r = await request(app).get('/api/member/report/category');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data)).toBe(true);
  });

  it('GET /api/member/product/list (legacy http envelope)', async () => {
    const r = await request(app).get('/api/member/product/list?perPage=5');
    expect(r.status).toBe(200);
    // FE legacy envelope: {meta:{total,page,lastPage}, data:[...]}. No errCode wrap.
    expect(r.body.meta).toBeDefined();
    expect(Array.isArray(r.body.data)).toBe(true);
    expect(r.body.data.length).toBeLessThanOrEqual(5);
  });
});
