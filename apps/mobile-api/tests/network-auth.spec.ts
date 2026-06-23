import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app';

// Regression for the CRITICAL unauthenticated PII leak: GET /network/member
// must reject anonymous callers. Before the fix the route had no authGuard and
// the empty-input "lists-all" path dumped every member's email/phone/address.
describe('network member/tag endpoints require auth', () => {
  const app = buildApp();

  it('GET /api/member/network/member without a token → 401 (no PII dump)', async () => {
    const res = await request(app).get('/api/member/network/member?page=1&perPage=100');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('GET /api/member/network/tag without a token → 401', async () => {
    const res = await request(app).get('/api/member/network/tag');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});
