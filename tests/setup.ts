import 'reflect-metadata';

process.env.NODE_ENV = 'test';
// Tests default to Model B (proxy) regardless of the dev .env; the signed-mode
// suite (media-signed.spec.ts) flips MEDIA_MODE in its own beforeAll.
process.env.MEDIA_MODE = 'proxy';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'test-admin-secret';
process.env.OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'test-client';
process.env.OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || 'test-secret';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres:root@localhost:5433/bb?schema=public';
process.env.XENDIT_CALLBACK_TOKEN = process.env.XENDIT_CALLBACK_TOKEN || 'test-xendit-token';
process.env.XENDIT_SECRET_KEY = process.env.XENDIT_SECRET_KEY || 'xnd_test_dummy';
process.env.REVENUECAT_WEBHOOK_AUTH = process.env.REVENUECAT_WEBHOOK_AUTH || 'test-rc-auth';
process.env.DIDIT_WEBHOOK_SECRET = process.env.DIDIT_WEBHOOK_SECRET || 'test-didit-webhook-secret';
process.env.GOOGLE_CLIENT_IDS = process.env.GOOGLE_CLIENT_IDS || 'test-google-android,test-google-ios';
