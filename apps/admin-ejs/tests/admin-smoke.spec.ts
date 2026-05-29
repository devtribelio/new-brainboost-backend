import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app';

describe('admin panel routes', () => {
  const app = buildApp();

  it('GET /admin/login renders login form', async () => {
    const res = await request(app).get('/admin/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<form');
    expect(res.text).toContain('action="/admin/login"');
  });

  it('GET /admin redirects to /admin/login when no cookie', async () => {
    const res = await request(app).get('/admin');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/login');
  });

  it('GET /admin/banners redirects when not authenticated', async () => {
    const res = await request(app).get('/admin/banners');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/login');
  });

  it('GET /admin/static/admin.css serves CSS', async () => {
    const res = await request(app).get('/admin/static/admin.css');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/css/);
    expect(res.text).toContain('.admin-shell');
  });

  it('POST /admin/login with empty body returns 400 with login form', async () => {
    const res = await request(app).post('/admin/login').type('form').send({});
    expect(res.status).toBe(400);
    expect(res.text).toContain('Email and password are required');
  });

  it('GET /health still works (existing API not broken)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { status: 'ok' } });
  });
});
