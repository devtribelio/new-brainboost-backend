// Single source of truth for "what must never appear in a log".
//
// Used twice, on purpose:
//   - `config/logger.ts` feeds `redactPaths` to pino's own `redact` option, which
//     covers structured fields on any log call anywhere in the codebase.
//   - `middlewares/request-logger.middleware.ts` calls `scrubDeep()` on the
//     request body BEFORE serialising it. pino's redact is not enough there: a
//     body over the size cap is logged as a JSON *string*, and redact only walks
//     object keys — it cannot touch secrets inside an already-serialised string.

export const SECRET_KEYS = [
  'password',
  'newPassword',
  'oldPassword',
  'currentPassword',
  'passwordConfirmation',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'authorization',
  'apiKey',
  'secret',
  'clientSecret',
  'otp',
  'otpCode',
  'pin',
  'nik',
  'sessionToken',
] as const;

export const CENSOR = '[redacted]';

// pino matches these literally, so the bare key and the common one-level nesting
// are both listed. Deeper nestings are handled by scrubDeep() where it matters.
export const redactPaths = [
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((k) => `*.${k}`),
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
];

const SECRET_SET = new Set<string>(SECRET_KEYS.map((k) => k.toLowerCase()));

// Bounded so a hostile or cyclic payload cannot turn logging into a hang. Past
// the limit the subtree is dropped rather than copied unredacted.
const MAX_DEPTH = 8;
const MAX_KEYS = 200;
const MAX_ARRAY = 50;

/**
 * Deep copy of `value` with every secret-named property replaced by `[redacted]`,
 * at ANY depth. Returns a new structure — the caller's object is never mutated
 * (mutating `req.body` would corrupt the request being served).
 */
export function scrubDeep(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  // Static `Buffer.byteLength`, not `value.length` — see the note in
  // request-logger.middleware.ts: no property read on request-derived data.
  if (Buffer.isBuffer(value)) return `[buffer ${Buffer.byteLength(value)}b]`;
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v) => scrubDeep(v, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`[+${value.length - MAX_ARRAY} more]`);
    return out;
  }

  const out: Record<string, unknown> = {};
  let seen = 0;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (seen++ >= MAX_KEYS) {
      out['[truncated]'] = `${Object.keys(value as object).length - MAX_KEYS} more keys`;
      break;
    }
    out[key] = SECRET_SET.has(key.toLowerCase()) ? CENSOR : scrubDeep(v, depth + 1);
  }
  return out;
}
