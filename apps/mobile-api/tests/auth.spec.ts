import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app';

describe('auth (contract)', () => {
  it('POST /api/member/oauth/token without body → 400 validation', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/member/oauth/token').send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('Validation');
  });

  it('POST /api/member/oauth/token with invalid grant_type → 400', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/member/oauth/token').send({ grant_type: 'unknown' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  describe('client_credentials grant', () => {
    it('valid client_id+secret → 200 with anon access_token, no refresh_token', async () => {
      const app = buildApp();
      const res = await request(app).post('/api/member/oauth/token').send({
        grant_type: 'client_credentials',
        client_id: 'test-client',
        client_secret: 'test-secret',
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.access_token).toBeTruthy();
      expect(res.body.data.refresh_token).toBeUndefined();
      expect(res.body.data.scope).toBe('anon');
      expect(res.body.data.token_type).toBe('Bearer');
    });

    it('wrong client_secret → 401', async () => {
      const app = buildApp();
      const res = await request(app).post('/api/member/oauth/token').send({
        grant_type: 'client_credentials',
        client_id: 'test-client',
        client_secret: 'WRONG',
      });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('missing client_id → 400', async () => {
      const app = buildApp();
      const res = await request(app).post('/api/member/oauth/token').send({
        grant_type: 'client_credentials',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('client_id');
    });

    it('anon access_token rejected by member-protected endpoints', async () => {
      const app = buildApp();
      const tok = await request(app).post('/api/member/oauth/token').send({
        grant_type: 'client_credentials',
        client_id: 'test-client',
        client_secret: 'test-secret',
      });
      const access = tok.body.data.access_token as string;
      const res = await request(app)
        .get('/api/member/account/profile/info')
        .set('Authorization', `Bearer ${access}`);
      expect(res.status).toBe(401);
    });
  });

  it('GET /api/member/info without auth → 200 with base info (pre-login splash)', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/member/info');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.appName).toBeTruthy();
    expect(Array.isArray(res.body.data.community)).toBe(true);
  });

  it('GET /api/member/notification/list (stubbed) without auth → 401', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/member/notification/list');
    expect(res.status).toBe(401);
  });

  it('GET /api/member/data/banner (paginated envelope) → 200', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/member/data/banner');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta.pagination).toBeDefined();
  });
});
