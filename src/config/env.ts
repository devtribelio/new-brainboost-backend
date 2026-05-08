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
} as const;

export type Env = typeof env;
