import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app';

// Both tracker endpoints are member-scoped; anonymous callers must be rejected
// before any DB access.
describe('tracker endpoints require auth', () => {
  const app = buildApp();

  it('POST /api/tracking/session without a token → 401', async () => {
    const res = await request(app)
      .post('/api/tracking/session')
      .send({
        clientSessionId: crypto.randomUUID(),
        audioId: crypto.randomUUID(),
        startedAt: new Date().toISOString(),
        listenedSec: 100,
        completed: false,
      });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('GET /api/user/stats/home without a token → 401', async () => {
    const res = await request(app).get('/api/user/stats/home');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});
