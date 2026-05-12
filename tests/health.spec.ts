import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app';

describe('health', () => {
  it('GET /health → 200 ok', async () => {
    const app = buildApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.errCode).toBe(0);
    expect(res.body.errMessage).toBeNull();
    expect(res.body.data.status).toBe('ok');
  });

  it('unknown route → 404 with structured error', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.errCode).toBe(404);
    expect(res.body.errMessage).toContain('Route not found');
    expect(res.body.data).toBeNull();
  });
});
