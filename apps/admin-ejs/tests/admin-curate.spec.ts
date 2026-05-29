import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app';

describe('admin curate endpoints', () => {
  const app = buildApp();

  it('POST /admin/posts/:id/curate redirects to login when not authenticated', async () => {
    const res = await request(app)
      .post('/admin/posts/some-id/curate')
      .type('form')
      .send({ isCurated: 'true' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/login');
  });

  it('POST /admin/comments/:id/curate redirects to login when not authenticated', async () => {
    const res = await request(app)
      .post('/admin/comments/some-id/curate')
      .type('form')
      .send({ isCurated: 'true' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/login');
  });
});
