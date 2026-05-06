import 'reflect-metadata';

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'test-admin-secret';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres:root@localhost:5433/bb?schema=public';
