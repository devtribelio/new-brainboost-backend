import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app';

describe('health', () => {
  it('GET /health → 200 ok', async () => {
    const app = buildApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.error).toBeNull();
    expect(res.body.data.status).toBe('ok');
  });

  it('unknown route → 404 with structured error', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    // The requested route moved from the message into `details` — the message is
    // user-facing copy and must not echo raw client input.
    expect(res.body.error.details).toMatchObject({ method: 'GET', path: '/api/does-not-exist' });
    expect(res.body.data).toBeNull();
  });
});
