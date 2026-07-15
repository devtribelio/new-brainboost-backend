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
  // Swagger UI / OpenAPI JSON exposure. Defaults ON so staging (which runs
  // NODE_ENV=production) keeps its docs for QA. Set API_DOCS_ENABLED=false in a
  // real public production environment to hide the API contract.
  apiDocsEnabled: optional('API_DOCS_ENABLED', 'true') !== 'false',
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
  apple: {
    // Sign in with Apple `aud` is the iOS bundle id(s) (e.g. com.brainboost.ios).
    // Optional: empty when unset, which makes the Apple flow report
    // "not configured" rather than breaking app startup.
    audiences: optional('APPLE_CLIENT_IDS', '')
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
  s3: {
    // Custom endpoint for S3-compatible backends (MinIO/R2). Empty = AWS default.
    endpoint: optional('S3_ENDPOINT', ''),
    region: optional('S3_REGION', 'ap-southeast-3'),
    // Credentials. Required in prod; in dev/test fall back to empty so the
    // client constructs without throwing (calls fail until configured).
    accessKeyId:
      nodeEnv === 'production' ? required('S3_ACCESS_KEY_ID') : optional('S3_ACCESS_KEY_ID', ''),
    secretAccessKey:
      nodeEnv === 'production'
        ? required('S3_SECRET_ACCESS_KEY')
        : optional('S3_SECRET_ACCESS_KEY', ''),
    bucket: nodeEnv === 'production' ? required('S3_BUCKET') : optional('S3_BUCKET', 'bb-uploads'),
    // true for MinIO / path-style backends, false for AWS virtual-host style.
    forcePathStyle: optional('S3_FORCE_PATH_STYLE', 'false') === 'true',
    // Public base URL (CDN or S3) prepended to `public/*` object keys.
    // e.g. https://cdn.brainboost.com  →  <base>/public/avatars/<id>.webp
    publicBaseUrl: optional('S3_PUBLIC_BASE_URL', ''),
    // Default presigned-GET lifetime for `private/*` objects, seconds.
    presignExpires: Number.parseInt(optional('S3_PRESIGN_EXPIRES', '900'), 10),
    // Max image side (px) after resize. Larger inputs downscaled, no upscale.
    imageMaxDimension: Number.parseInt(optional('S3_IMAGE_MAX_DIMENSION', '1024'), 10),
    // webp quality 1-100 for re-encoded images.
    imageWebpQuality: Number.parseInt(optional('S3_IMAGE_WEBP_QUALITY', '82'), 10),
  },
  cors: {
    // Browser origin allowlist (comma-separated). Empty = allow all (`*`, no
    // credentials) — fine for native mobile clients which don't enforce CORS.
    // Set an explicit list for web FE that needs cookie/credential requests.
    allowedOrigins: optional('CORS_ALLOWED_ORIGINS', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // Send Access-Control-Allow-Credentials. Only effective with an allowlist
    // (the CORS spec forbids combining `*` with credentials).
    credentials: optional('CORS_CREDENTIALS', 'false') === 'true',
  },
  baseUrl: optional('BASE_URL', 'http://localhost:3000'),
  // Express `trust proxy` setting. Empty = off (req.ip = socket address).
  // Set to a hop count ("1") behind a reverse proxy / LB so req.ip reflects
  // the real client IP — required for per-IP rate limiting to work correctly.
  // Also accepts Express values like "loopback" or a CIDR list.
  trustProxy: optional('TRUST_PROXY', ''),
  log: {
    level: optional('LOG_LEVEL', 'info'),
  },
  // NOTE: SMTP (email) + Qontak (WhatsApp) delivery moved OUT to the separate
  // bb-comms worker (ADR-0002). bb-platform only enqueues to the comms outbox;
  // those provider creds live in bb-comms' env now, not here.
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
  didit: {
    // API key from the Didit Console (Settings → API Keys). Sent as the `x-api-key`
    // header on every server-to-server call. Empty = Didit KYC disabled (session
    // endpoint 503s, webhook guard fails closed).
    apiKey: optional('DIDIT_API_KEY', ''),
    // Per-destination "secret_shared_key" from the Console (Webhooks → destination).
    // Used to verify the X-Signature HMAC-SHA256 over the raw webhook body — this is
    // NOT the apiKey.
    webhookSecret: optional('DIDIT_WEBHOOK_SECRET', ''),
    // Published verification workflow UUID (Console → Workflows). Defines which
    // checks run (ID doc + liveness + face match).
    workflowId: optional('DIDIT_WORKFLOW_ID', ''),
    baseUrl: optional('DIDIT_BASE_URL', 'https://verification.didit.me'),
    // Optional redirect URL for the hosted-webview fallback (deep link back into the
    // app, e.g. brainboost://kyc/done). Unused on the native-SDK path. Empty = omit.
    callbackUrl: optional('DIDIT_CALLBACK_URL', ''),
  },
  rekyc: {
    // Re-KYC thresholds: an APPROVED affiliate is forced to re-verify on a risk
    // event before the next disbursement. See docs/specs/kyc-rekyc.md.
    // Reactivation after this many days idle (lastActiveAt gap) resets KYC.
    dormantDays: Number.parseInt(optional('REKYC_DORMANT_DAYS', '365'), 10),
    // A disbursement >= this amount (IDR) forces re-KYC when the last review is stale.
    largeDisbursementIdr: Number.parseInt(optional('REKYC_LARGE_DISBURSEMENT_IDR', '5000000'), 10),
    // "Stale" = last KYC review older than this; guards against re-KYC right after approval.
    staleDays: Number.parseInt(optional('REKYC_STALE_DAYS', '180'), 10),
  },
  revenuecat: {
    // Shared secret RevenueCat sends as the `Authorization` header on each
    // webhook (configured in the RC dashboard). Empty disables the endpoint
    // (guard fails closed → 401). Optional (like xendit.callbackToken) so apps
    // that never serve this webhook still boot in prod.
    webhookAuth: optional('REVENUECAT_WEBHOOK_AUTH', ''),
    // ThirdPartyCredential.name row the handler loads for per-channel toggles
    // (triggersAffiliate / canIngestRefund). Must match the seeded credential.
    providerName: optional('REVENUECAT_PROVIDER_NAME', 'revenuecat'),
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
    // Token Authentication key for signed CDN URLs (Model C / signed mode).
    // Secret; empty in proxy mode. Belongs to the Token-Auth-enabled Stream library.
    streamTokenKey: optional('BUNNY_STREAM_TOKEN_KEY', ''),
  },
  media: {
    // AES-256-GCM key source for opaque media stream tokens. Required in prod.
    tokenSecret:
      nodeEnv === 'production'
        ? required('MEDIA_TOKEN_SECRET')
        : optional('MEDIA_TOKEN_SECRET', 'dev-insecure-media-token-secret-change-me'),
    tokenTtlSeconds: Number.parseInt(optional('MEDIA_TOKEN_TTL_SECONDS', '21600'), 10),
    defaultResolution: optional('MEDIA_DEFAULT_RESOLUTION', '720p'),
    // 'proxy' = Model B (backend streams the bytes); 'signed' = Model C (302 to a
    // signed Bunny URL, client streams from the edge). See docs/specs/media-model-c-migration.md.
    mode: (optional('MEDIA_MODE', 'proxy') === 'signed' ? 'signed' : 'proxy') as 'proxy' | 'signed',
    // Signed-URL lifetime for Model C streaming, seconds.
    signedUrlTtlSeconds: Number.parseInt(optional('MEDIA_SIGNED_URL_TTL_SECONDS', '7200'), 10),
    // Signed-URL lifetime for offline downloads — longer than streaming so slow
    // downloads don't outlive the token. Applies to the opaque media token AND
    // the Bunny CDN signed URL.
    downloadTtlSeconds: Number.parseInt(optional('MEDIA_DOWNLOAD_TTL_SECONDS', '86400'), 10),
  },
  // Amazon SQS — comms outbox publisher (bb-comms worker consumes). Only
  // CONNECTION params live here; queue NAMES are code constants in mq/topology.ts
  // (memory feedback_messaging_config), full queue URLs are env (they embed
  // account id + region). Local dev points `endpoint` at ElasticMQ
  // (http://localhost:9324) with dummy creds; prod leaves `endpoint` + creds
  // empty so the SDK resolves the real AWS endpoint + IAM-role creds. Empty queue
  // URLs = relay runs in log-only dev mode. See docs/adr/0002.
  sqs: {
    region: optional('SQS_REGION', 'ap-southeast-3'),
    // Local only: ElasticMQ endpoint. Empty in prod (SDK uses AWS default).
    endpoint: optional('SQS_ENDPOINT', ''),
    // Local/dev creds for ElasticMQ. Empty in prod -> SDK uses the task IAM role.
    accessKeyId: optional('SQS_ACCESS_KEY_ID', ''),
    secretAccessKey: optional('SQS_SECRET_ACCESS_KEY', ''),
    // One Standard queue per priority (former direct-exchange routing keys).
    urgentQueueUrl: optional('SQS_COMMS_URGENT_URL', ''),
    normalQueueUrl: optional('SQS_COMMS_NORMAL_URL', ''),
    // Relay daemon poll interval + batch size.
    relayIntervalMs: Number.parseInt(optional('COMMS_RELAY_INTERVAL_MS', '2000'), 10),
    relayBatchSize: Number.parseInt(optional('COMMS_RELAY_BATCH_SIZE', '50'), 10),
  },
} as const;

/**
 * Fixed-OTP bypass for designated tester accounts (e.g. the Apple App Review
 * reviewer). When enabled, any OTP for a whitelisted email/phone is satisfied by
 * the fixed `code` instead of a real one — no code is generated, stored, or sent.
 *
 * Read LIVE from process.env (not baked into `env`) so it can be flipped at
 * runtime and toggled in tests without re-importing. This is still the single
 * declaration site for these vars.
 *
 * SECURITY: must be a kill-switch (default OFF) limited to dummy accounts only.
 * Adding a real user's identifier here lets `000000` reset their password via
 * forgot-password. See docs/specs/test-account.md.
 */
export function testAccountConfig(): {
  enabled: boolean;
  code: string;
  identifiers: string[];
} {
  return {
    enabled: optional('TEST_ACCOUNT_ENABLED', 'false') === 'true',
    code: optional('TEST_ACCOUNT_OTP_CODE', '000000'),
    identifiers: optional('TEST_ACCOUNT_IDENTIFIERS', '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}

export type Env = typeof env;
