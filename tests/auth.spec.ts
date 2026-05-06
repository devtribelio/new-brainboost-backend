import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app';

describe('auth (contract)', () => {
  it('POST /api/member/oauth/token without body → 400 validation', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/member/oauth/token').send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.message).toContain('Validation');
  });

  it('POST /api/member/oauth/token with invalid grant_type → 400', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/member/oauth/token').send({ grant_type: 'unknown' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('GET /api/member/info without auth → 401', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/member/info');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('GET /api/member/notification/list (stubbed) without auth → 401', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/member/notification/list');
    expect(res.status).toBe(401);
  });

  it('GET /api/member/data/banner (stubbed, public) → 501', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/member/data/banner');
    expect(res.status).toBe(501);
    expect(res.body.error.message).toContain('Not Implemented');
  });
});
