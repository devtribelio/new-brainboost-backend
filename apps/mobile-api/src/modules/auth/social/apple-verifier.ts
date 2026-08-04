import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '@bb/common/config/env';
import { badRequest, unauthorized, ERROR_CODES } from '@bb/common/exceptions';

export interface AppleIdentityPayload {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

// Apple's published signing keys. createRemoteJWKSet caches keys internally and
// refreshes on key rotation, so this is created once at module scope.
const APPLE_JWKS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

export async function verifyAppleIdentityToken(idToken: string): Promise<AppleIdentityPayload> {
  if (env.apple.audiences.length === 0) {
    throw badRequest(ERROR_CODES.SOCIAL_SIGNIN_NOT_CONFIGURED);
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, APPLE_JWKS, {
      issuer: 'https://appleid.apple.com',
      audience: env.apple.audiences,
      algorithms: ['RS256'],
    }));
  } catch {
    throw unauthorized(ERROR_CODES.APPLE_ID_TOKEN_INVALID);
  }

  if (!payload.sub) {
    throw unauthorized(ERROR_CODES.APPLE_ID_TOKEN_INVALID);
  }

  // Apple emits `email_verified` (and `is_private_email`) as either a JSON
  // boolean or a string ("true"/"false") depending on the flow.
  const rawVerified = (payload as { email_verified?: unknown }).email_verified;
  const emailVerified = rawVerified === true || rawVerified === 'true';

  // Apple includes the email in the identity token, but may omit it on repeat
  // logins. The name is never present in the identity token.
  const email = typeof payload.email === 'string' ? payload.email : null;

  return {
    sub: payload.sub,
    email,
    emailVerified,
    name: null,
  };
}
