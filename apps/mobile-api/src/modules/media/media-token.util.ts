import crypto from 'node:crypto';
import { env } from '@bb/common/config/env';
import { UnauthorizedException } from '@bb/common/exceptions';

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

interface MediaTokenEnvelope extends MediaTokenPayload {
  /** Expiry, unix seconds. */
  exp: number;
}

const IV_LEN = 12;
const TAG_LEN = 16;

/** Derive a stable 32-byte AES key from the configured secret. */
function aesKey(): Buffer {
  return crypto.createHash('sha256').update(env.media.tokenSecret).digest();
}

/**
 * Encrypt a media token. Default TTL comes from `MEDIA_TOKEN_TTL_SECONDS`;
 * callers may pass a longer TTL for offline-download flows.
 */
export function signMediaToken(
  payload: MediaTokenPayload,
  ttlSeconds: number = env.media.tokenTtlSeconds,
): string {
  const envelope: MediaTokenEnvelope = {
    guid: payload.guid,
    courseId: payload.courseId,
    isPreview: payload.isPreview,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(envelope), 'utf8')),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

/**
 * Decrypt and validate a media token. Throws `UnauthorizedException` for any
 * malformed, tampered, or expired token.
 */
export function verifyMediaToken(token: string): MediaTokenPayload {
  const raw = Buffer.from(token ?? '', 'base64url');
  if (raw.length < IV_LEN + TAG_LEN + 1) {
    throw new UnauthorizedException('Invalid media token');
  }
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = raw.subarray(IV_LEN + TAG_LEN);

  let envelope: MediaTokenEnvelope;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    envelope = JSON.parse(plaintext.toString('utf8')) as MediaTokenEnvelope;
  } catch {
    throw new UnauthorizedException('Invalid media token');
  }

  if (typeof envelope.exp !== 'number' || envelope.exp * 1000 < Date.now()) {
    throw new UnauthorizedException('Media token expired');
  }
  if (typeof envelope.guid !== 'string' || typeof envelope.courseId !== 'string') {
    throw new UnauthorizedException('Invalid media token');
  }
  return {
    guid: envelope.guid,
    courseId: envelope.courseId,
    isPreview: envelope.isPreview === true,
  };
}
