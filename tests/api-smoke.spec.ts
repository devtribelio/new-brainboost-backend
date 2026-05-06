import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app';

describe('legacy-aligned API smoke', () => {
  const app = buildApp();

  it('GET /api/member/data/banner', async () => {
    const r = await request(app).get('/api/member/data/banner');
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });

  it('GET /api/member/data/location/country pagination', async () => {
    const r = await request(app).get('/api/member/data/location/country?page=1&perPage=5');
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBeLessThanOrEqual(5);
    expect(r.body.meta.total).toBeGreaterThan(0);
  });

  it('GET /api/member/topic/list', async () => {
    const r = await request(app).get('/api/member/topic/list?perPage=3');
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBeLessThanOrEqual(3);
  });

  it('GET /api/member/post/list public', async () => {
    const r = await request(app).get('/api/member/post/list?perPage=3');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data)).toBe(true);
    if (r.body.data.length > 0) {
      const p = r.body.data[0];
      expect(p).toHaveProperty('postId');
      expect(p).toHaveProperty('content');
      expect(p).toHaveProperty('countLike');
    }
  });

  it('GET /api/member/post/detail with legacyId', async () => {
    const list = await request(app).get('/api/member/post/list?perPage=1');
    const postId = list.body.data[0]?.postId;
    if (!postId) return;
    const r = await request(app).get('/api/member/post/detail').query({ postId });
    expect(r.status).toBe(200);
    expect(r.body.data.postId).toBe(postId);
  });

  it('GET /api/member/comment/list requires postId', async () => {
    const r = await request(app).get('/api/member/comment/list');
    expect(r.status).toBe(400);
  });

  it('GET /api/member/network/member requires networkId', async () => {
    const r = await request(app).get('/api/member/network/member');
    expect(r.status).toBe(400);
  });

  it('GET /api/member/report/category', async () => {
    const r = await request(app).get('/api/member/report/category');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data)).toBe(true);
  });

  it('GET /api/member/product/list', async () => {
    const r = await request(app).get('/api/member/product/list?perPage=5');
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBeLessThanOrEqual(5);
  });
});
