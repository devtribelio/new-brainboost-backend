import { OAuth2Client } from 'google-auth-library';
import { env } from '@/config/env';
import { BadRequestException, UnauthorizedException } from '@/common/exceptions';

export interface GoogleIdTokenPayload {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

const client = new OAuth2Client();

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdTokenPayload> {
  if (env.google.audiences.length === 0) {
    throw new BadRequestException('Google sign-in not configured');
  }

  let ticket;
  try {
    ticket = await client.verifyIdToken({
      idToken,
      audience: env.google.audiences,
    });
  } catch {
    throw new UnauthorizedException('invalid_google_id_token');
  }

  const payload = ticket.getPayload();
  if (!payload || !payload.sub || !payload.email) {
    throw new UnauthorizedException('invalid_google_id_token');
  }

  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    name: payload.name ?? null,
  };
}
