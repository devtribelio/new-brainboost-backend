import 'dotenv/config';

type NodeEnv = 'development' | 'test' | 'production';

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value : fallback;
}

const nodeEnv = optional('NODE_ENV', 'development') as NodeEnv;

export const env = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',
  appName: optional('APP_NAME', 'bb-backend'),
  port: Number.parseInt(optional('PORT', '3000'), 10),
  databaseUrl: required('DATABASE_URL'),
  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    accessExpiresIn: optional('JWT_ACCESS_EXPIRES_IN', '15m'),
    refreshExpiresIn: optional('JWT_REFRESH_EXPIRES_IN', '30d'),
    anonExpiresIn: optional('JWT_ANON_EXPIRES_IN', '1h'),
  },
  oauth: {
    clientId: optional('OAUTH_CLIENT_ID', ''),
    clientSecret: optional('OAUTH_CLIENT_SECRET', ''),
  },
  google: {
    audiences: optional('GOOGLE_CLIENT_IDS', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  admin: {
    jwtSecret: required('ADMIN_JWT_SECRET'),
    jwtTtl: optional('ADMIN_JWT_TTL', '8h'),
    cookieName: optional('ADMIN_COOKIE_NAME', 'bb_admin'),
  },
  upload: {
    tempDir: optional('UPLOAD_TEMP_DIR', './uploads/temporary'),
    publicBaseUrl: optional('UPLOAD_PUBLIC_BASE_URL', ''),
    maxBytes: Number.parseInt(optional('UPLOAD_MAX_BYTES', String(10 * 1024 * 1024)), 10),
  },
  baseUrl: optional('BASE_URL', 'http://localhost:3000'),
  smtp: {
    host: optional('SMTP_HOST', ''),
    port: Number.parseInt(optional('SMTP_PORT', '587'), 10),
    user: optional('SMTP_USER', ''),
    pass: optional('SMTP_PASS', ''),
    from: optional('SMTP_FROM', 'no-reply@brainboost.local'),
    secure: optional('SMTP_SECURE', 'false') === 'true',
  },
  log: {
    level: optional('LOG_LEVEL', 'info'),
  },
  xendit: {
    secretKey: optional('XENDIT_SECRET_KEY', ''),
    callbackToken: optional('XENDIT_CALLBACK_TOKEN', ''),
    invoiceSuccessUrl: optional(
      'XENDIT_INVOICE_SUCCESS_URL',
      'http://localhost:3000/checkout/success',
    ),
    invoiceFailureUrl: optional(
      'XENDIT_INVOICE_FAILURE_URL',
      'http://localhost:3000/checkout/failed',
    ),
  },
  commerce: {
    transactionExpiryHours: Number.parseInt(
      optional('COMMERCE_TRANSACTION_EXPIRY_HOURS', '24'),
      10,
    ),
    invoiceExpiryHours: Number.parseInt(optional('COMMERCE_INVOICE_EXPIRY_HOURS', '24'), 10),
  },
  fcm: {
    projectId: optional('FCM_PROJECT_ID', ''),
    serviceAccountJson: optional('FCM_SERVICE_ACCOUNT_JSON', ''),
  },
  bunny: {
    // Bunny Stream library CDN delivery host — serves play_{res}.mp4 / original.
    streamCdnHost: optional('BUNNY_STREAM_CDN_HOST', 'vz-5439ef3e-878.b-cdn.net'),
    // Stream library id — management API only; not needed for CDN fetch.
    streamLibraryId: optional('BUNNY_STREAM_LIBRARY_ID', '157244'),
    // Management API key (video.bunnycdn.com) — metadata calls. Optional.
    streamApiKey: optional('BUNNY_STREAM_API_KEY', ''),
    // Referer sent on CDN fetch — Bunny pull zone blocks empty-referer requests.
    referer: optional('BUNNY_REFERER', 'https://brainboost.id'),
  },
  media: {
    // AES-256-GCM key source for opaque media stream tokens. Required in prod.
    tokenSecret:
      nodeEnv === 'production'
        ? required('MEDIA_TOKEN_SECRET')
        : optional('MEDIA_TOKEN_SECRET', 'dev-insecure-media-token-secret-change-me'),
    tokenTtlSeconds: Number.parseInt(optional('MEDIA_TOKEN_TTL_SECONDS', '21600'), 10),
    defaultResolution: optional('MEDIA_DEFAULT_RESOLUTION', '720p'),
  },
} as const;

export type Env = typeof env;
