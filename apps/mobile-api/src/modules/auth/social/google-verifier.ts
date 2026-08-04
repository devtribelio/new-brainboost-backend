import { OAuth2Client } from 'google-auth-library';
import { env } from '@bb/common/config/env';
import { badRequest, unauthorized, ERROR_CODES } from '@bb/common/exceptions';

export interface GoogleIdTokenPayload {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

const client = new OAuth2Client();

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdTokenPayload> {
  if (env.google.audiences.length === 0) {
    throw badRequest(ERROR_CODES.SOCIAL_SIGNIN_NOT_CONFIGURED);
  }

  let ticket;
  try {
    ticket = await client.verifyIdToken({
      idToken,
      audience: env.google.audiences,
    });
  } catch {
    throw unauthorized(ERROR_CODES.GOOGLE_ID_TOKEN_INVALID);
  }

  const payload = ticket.getPayload();
  if (!payload || !payload.sub || !payload.email) {
    throw unauthorized(ERROR_CODES.GOOGLE_ID_TOKEN_INVALID);
  }

  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    name: payload.name ?? null,
  };
}
