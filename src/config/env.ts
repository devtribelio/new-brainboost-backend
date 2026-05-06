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
  },
  admin: {
    jwtSecret: required('ADMIN_JWT_SECRET'),
    jwtTtl: optional('ADMIN_JWT_TTL', '8h'),
    cookieName: optional('ADMIN_COOKIE_NAME', 'bb_admin'),
  },
  upload: {
    tempDir: optional('UPLOAD_TEMP_DIR', './tmp/uploads'),
  },
  log: {
    level: optional('LOG_LEVEL', 'info'),
  },
} as const;

export type Env = typeof env;
