import { describe, it, expect } from 'vitest';
import {
  signMediaToken,
  verifyMediaToken,
  type MediaTokenPayload,
} from '../src/modules/media/media-token.util';
import { UnauthorizedException } from '@bb/common/exceptions';

const payload: MediaTokenPayload = {
  guid: 'bunny-guid-abc-123',
  courseId: '7a3c1a52-9f1b-4f8b-9d2a-1e0a7b1c4d51',
  isPreview: false,
};

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
});
