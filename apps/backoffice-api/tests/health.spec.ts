import request from 'supertest';
import { buildApp } from '../src/app';

describe('backoffice-api scaffold', () => {
  const app = buildApp();

  it('GET /health → 200', async () => {
    const r = await request(app).get('/health');
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.data.service).toBe('backoffice-api');
  });

  it('unknown route → 404 envelope', async () => {
    const r = await request(app).get('/api/backoffice/does-not-exist');
    expect(r.status).toBe(404);
    expect(r.body.success).toBe(false);
  });
});
