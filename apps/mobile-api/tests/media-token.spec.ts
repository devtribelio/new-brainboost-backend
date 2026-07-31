import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  signMediaToken,
  verifyMediaToken,
  signDocumentToken,
  verifyDocumentToken,
  type MediaTokenPayload,
  type DocumentTokenPayload,
} from '../src/modules/media/media-token.util';
import { env } from '@bb/common/config/env';
import { UnauthorizedException } from '@bb/common/exceptions';

const payload: MediaTokenPayload = {
  guid: 'bunny-guid-abc-123',
  courseId: '7a3c1a52-9f1b-4f8b-9d2a-1e0a7b1c4d51',
  isPreview: false,
};

const docPayload: DocumentTokenPayload = {
  key: 'private/lesson-doc/7a3c1a52-9f1b-4f8b-9d2a-1e0a7b1c4d51/workbook.pdf',
  courseId: '7a3c1a52-9f1b-4f8b-9d2a-1e0a7b1c4d51',
  isPreview: false,
};

/**
 * Mint a token the way the util did before documents existed: same crypto, but
 * no `k` discriminator in the envelope. Guards the backward-compat path — long
 * TTL download tokens outlive a deploy.
 */
function signLegacyMediaToken(p: MediaTokenPayload, ttlSeconds = 600): string {
  const envelope = {
    guid: p.guid,
    courseId: p.courseId,
    isPreview: p.isPreview,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const key = crypto.createHash('sha256').update(env.media.tokenSecret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(envelope), 'utf8')),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

describe('media token util', () => {
  it('round-trips a payload through sign → verify', () => {
    const token = signMediaToken(payload);
    const decoded = verifyMediaToken(token);
    expect(decoded).toEqual(payload);
  });

  it('preserves the isPreview flag', () => {
    const previewToken = signMediaToken({ ...payload, isPreview: true });
    expect(verifyMediaToken(previewToken).isPreview).toBe(true);
  });

  it('rejects a tampered token', () => {
    const token = signMediaToken(payload);
    // Flip a bit inside the decoded ciphertext so the GCM tag no longer matches.
    const raw = Buffer.from(token, 'base64url');
    raw[raw.length - 1] ^= 0xff;
    const tampered = raw.toString('base64url');
    expect(() => verifyMediaToken(tampered)).toThrow(UnauthorizedException);
  });

  it('rejects a garbage / non-token string', () => {
    expect(() => verifyMediaToken('not-a-real-token')).toThrow(UnauthorizedException);
    expect(() => verifyMediaToken('')).toThrow(UnauthorizedException);
  });

  it('rejects an expired token', () => {
    const expired = signMediaToken(payload, -1);
    expect(() => verifyMediaToken(expired)).toThrow(UnauthorizedException);
  });

  it('still verifies a legacy token minted before the kind discriminator existed', () => {
    expect(verifyMediaToken(signLegacyMediaToken(payload))).toEqual(payload);
  });
});

describe('document token util', () => {
  it('round-trips a payload through sign → verify', () => {
    expect(verifyDocumentToken(signDocumentToken(docPayload))).toEqual(docPayload);
  });

  it('preserves the isPreview flag', () => {
    const previewToken = signDocumentToken({ ...docPayload, isPreview: true });
    expect(verifyDocumentToken(previewToken).isPreview).toBe(true);
  });

  it('rejects an expired token', () => {
    expect(() => verifyDocumentToken(signDocumentToken(docPayload, -1))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a tampered token', () => {
    const raw = Buffer.from(signDocumentToken(docPayload), 'base64url');
    raw[raw.length - 1] ^= 0xff;
    expect(() => verifyDocumentToken(raw.toString('base64url'))).toThrow(UnauthorizedException);
  });

  // The two kinds must never be interchangeable: a media token resolving to an
  // S3 key (or a document token to a Bunny guid) would cross the gate boundary.
  it('rejects a media token', () => {
    expect(() => verifyDocumentToken(signMediaToken(payload))).toThrow(UnauthorizedException);
    expect(() => verifyDocumentToken(signLegacyMediaToken(payload))).toThrow(UnauthorizedException);
  });

  it('is rejected by the media verifier', () => {
    expect(() => verifyMediaToken(signDocumentToken(docPayload))).toThrow(UnauthorizedException);
  });
});
