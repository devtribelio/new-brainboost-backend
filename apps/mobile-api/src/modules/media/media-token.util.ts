import crypto from 'node:crypto';
import { env } from '@bb/common/config/env';
import { unauthorized, ERROR_CODES, UnauthorizedException } from '@bb/common/exceptions';

/**
 * Opaque media stream token.
 *
 * Emitted by the product serializer in place of the raw Bunny `guid` /
 * `videoLibraryId` so those identifiers never reach the frontend. The media
 * proxy endpoint decrypts it to learn which Bunny asset to stream and whether
 * an enrollment check is required.
 *
 * Format: AES-256-GCM over a JSON envelope, packed as `iv(12) | tag(16) |
 * ciphertext` and base64url-encoded. Encryption (not just signing) keeps the
 * `guid` itself secret; the GCM tag makes the payload tamper-evident.
 */
export interface MediaTokenPayload {
  /** Bunny Stream video guid — the real asset identifier, kept server-side. */
  guid: string;
  /** Course UUID — used to check enrollment for non-preview media. */
  courseId: string;
  /** Preview media is playable without enrollment (and anonymously). */
  isPreview: boolean;
}

/**
 * Opaque document token — same crypto, different payload.
 *
 * Emitted by the product serializer for `DocumentTemplate` slides in place of
 * the private S3 key. The document endpoint decrypts it, re-checks enrollment,
 * and 302s to a short-lived presigned GET. The key never reaches the client.
 */
export interface DocumentTokenPayload {
  /** S3 object key under the `private/` prefix — kept server-side. */
  key: string;
  /** Course UUID — used to check enrollment for non-preview documents. */
  courseId: string;
  /** A document on a preview lesson is readable without enrollment. */
  isPreview: boolean;
}

/**
 * Token kind. Absent on tokens minted before documents existed, which are
 * always video — download tokens are long-lived, so old ones are still in
 * circulation after a deploy and must keep verifying.
 */
type TokenKind = 'v' | 'd';

interface TokenEnvelope {
  /** Expiry, unix seconds. */
  exp: number;
  /** Token kind; `undefined` on legacy tokens = video. */
  k?: TokenKind;
  courseId?: unknown;
  isPreview?: unknown;
  /** Video only. */
  guid?: unknown;
  /** Document only. */
  key?: unknown;
}

const IV_LEN = 12;
const TAG_LEN = 16;

/** Derive a stable 32-byte AES key from the configured secret. */
function aesKey(): Buffer {
  return crypto.createHash('sha256').update(env.media.tokenSecret).digest();
}

/** Encrypt an envelope as `iv(12) | tag(16) | ciphertext`, base64url-encoded. */
function seal(envelope: TokenEnvelope): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(envelope), 'utf8')),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

/**
 * Decrypt an envelope and check expiry. Throws `UnauthorizedException` for any
 * malformed, tampered, or expired token. Payload-shape checks live in the
 * per-kind wrappers below.
 */
function open(token: string): TokenEnvelope {
  const raw = Buffer.from(token ?? '', 'base64url');
  if (raw.length < IV_LEN + TAG_LEN + 1) {
    throw unauthorized(ERROR_CODES.MEDIA_TOKEN_INVALID);
  }
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = raw.subarray(IV_LEN + TAG_LEN);

  let envelope: TokenEnvelope;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    envelope = JSON.parse(plaintext.toString('utf8')) as TokenEnvelope;
  } catch {
    throw unauthorized(ERROR_CODES.MEDIA_TOKEN_INVALID);
  }

  if (typeof envelope.exp !== 'number' || envelope.exp * 1000 < Date.now()) {
    throw unauthorized(ERROR_CODES.MEDIA_TOKEN_EXPIRED);
  }
  return envelope;
}

function expiryAt(ttlSeconds: number): number {
  return Math.floor(Date.now() / 1000) + ttlSeconds;
}

/**
 * Encrypt a media token. Default TTL comes from `MEDIA_TOKEN_TTL_SECONDS`;
 * callers may pass a longer TTL for offline-download flows.
 */
export function signMediaToken(
  payload: MediaTokenPayload,
  ttlSeconds: number = env.media.tokenTtlSeconds,
): string {
  return seal({
    k: 'v',
    guid: payload.guid,
    courseId: payload.courseId,
    isPreview: payload.isPreview,
    exp: expiryAt(ttlSeconds),
  });
}

/**
 * Decrypt and validate a media token. Throws `UnauthorizedException` for any
 * malformed, tampered, or expired token — and for a document token, so the two
 * kinds can never be swapped across endpoints.
 */
export function verifyMediaToken(token: string): MediaTokenPayload {
  const envelope = open(token);
  if (envelope.k === 'd') {
    throw unauthorized(ERROR_CODES.MEDIA_TOKEN_INVALID);
  }
  if (typeof envelope.guid !== 'string' || typeof envelope.courseId !== 'string') {
    throw unauthorized(ERROR_CODES.MEDIA_TOKEN_INVALID);
  }
  return {
    guid: envelope.guid,
    courseId: envelope.courseId,
    isPreview: envelope.isPreview === true,
  };
}

/**
 * Encrypt a document token. Defaults to the download TTL rather than the short
 * stream TTL: a client may open a document long after the course detail that
 * carried the token was fetched. This is not the access gate — the endpoint
 * re-checks enrollment on every request.
 */
export function signDocumentToken(
  payload: DocumentTokenPayload,
  ttlSeconds: number = env.media.downloadTtlSeconds,
): string {
  return seal({
    k: 'd',
    key: payload.key,
    courseId: payload.courseId,
    isPreview: payload.isPreview,
    exp: expiryAt(ttlSeconds),
  });
}

/**
 * Decrypt and validate a document token. Rejects video tokens outright — a
 * media token must never resolve to an S3 key, and vice versa.
 */
export function verifyDocumentToken(token: string): DocumentTokenPayload {
  const envelope = open(token);
  if (envelope.k !== 'd') {
    throw unauthorized(ERROR_CODES.MEDIA_TOKEN_INVALID);
  }
  if (typeof envelope.key !== 'string' || typeof envelope.courseId !== 'string') {
    throw unauthorized(ERROR_CODES.MEDIA_TOKEN_INVALID);
  }
  return {
    key: envelope.key,
    courseId: envelope.courseId,
    isPreview: envelope.isPreview === true,
  };
}
