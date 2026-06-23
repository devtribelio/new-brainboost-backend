import { describe, it, expect, beforeEach, vi } from 'vitest';

// jose is mocked at module scope so the verifier never reaches out to Apple's
// JWKS endpoint. createRemoteJWKSet returns an opaque key-set object (the
// verifier only passes it through to jwtVerify), and jwtVerify is the seam we
// drive per-test.
const { jwtVerifyMock, createRemoteJWKSetMock } = vi.hoisted(() => ({
  jwtVerifyMock: vi.fn(),
  createRemoteJWKSetMock: vi.fn(() => ({ __jwks: true })),
}));
vi.mock('jose', () => ({
  jwtVerify: jwtVerifyMock,
  createRemoteJWKSet: createRemoteJWKSetMock,
}));

// env.apple.audiences must be non-empty for the verifier to attempt verification.
// Set before importing the module under test (env is evaluated at import time).
process.env.APPLE_CLIENT_IDS = 'com.brainboost.ios';

const { verifyAppleIdentityToken } = await import(
  '../src/modules/auth/social/apple-verifier'
);

beforeEach(() => {
  jwtVerifyMock.mockReset();
});

describe('verifyAppleIdentityToken', () => {
  it('returns sub/email/emailVerified/name from a valid token', async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { sub: 'apple-user-1', email: 'a@example.com', email_verified: true },
    });

    const result = await verifyAppleIdentityToken('valid.jwt.token');

    expect(result).toEqual({
      sub: 'apple-user-1',
      email: 'a@example.com',
      emailVerified: true,
      name: null, // Apple never puts name in the identity token.
    });
  });

  it('passes the correct issuer/audience/algorithms to jwtVerify', async () => {
    jwtVerifyMock.mockResolvedValueOnce({ payload: { sub: 'apple-user-2' } });

    await verifyAppleIdentityToken('valid.jwt.token');

    expect(jwtVerifyMock).toHaveBeenCalledWith(
      'valid.jwt.token',
      expect.anything(),
      expect.objectContaining({
        issuer: 'https://appleid.apple.com',
        audience: ['com.brainboost.ios'],
        algorithms: ['RS256'],
      }),
    );
  });

  it('treats email_verified as the string "true"', async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { sub: 'apple-user-3', email: 'b@example.com', email_verified: 'true' },
    });

    const result = await verifyAppleIdentityToken('valid.jwt.token');
    expect(result.emailVerified).toBe(true);
  });

  it('tolerates a missing email (null, not a crash)', async () => {
    jwtVerifyMock.mockResolvedValueOnce({ payload: { sub: 'apple-user-4' } });

    const result = await verifyAppleIdentityToken('valid.jwt.token');
    expect(result.email).toBeNull();
    expect(result.emailVerified).toBe(false);
  });

  it('throws invalid_apple_id_token on a verify failure', async () => {
    jwtVerifyMock.mockRejectedValueOnce(new Error('signature verification failed'));

    await expect(verifyAppleIdentityToken('bad.jwt.token')).rejects.toMatchObject({
      message: 'invalid_apple_id_token',
    });
  });

  it('throws invalid_apple_id_token when sub is missing', async () => {
    jwtVerifyMock.mockResolvedValueOnce({ payload: { email: 'c@example.com' } });

    await expect(verifyAppleIdentityToken('no.sub.token')).rejects.toMatchObject({
      message: 'invalid_apple_id_token',
    });
  });
});
