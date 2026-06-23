import type { Request } from 'express';
import { Strategy } from 'passport-strategy';
import { verifyGoogleIdToken, type GoogleIdTokenPayload } from '../social/google-verifier';

/**
 * Passport strategy for Google id_token (mobile/native sign-in).
 * Client sends `social_token` in the request body — strategy verifies signature,
 * audience, and expiry via google-auth-library, then yields the payload.
 */
export class GoogleIdTokenStrategy extends Strategy {
  name = 'google-id-token';

  authenticate(req: Request): void {
    const token = (req.body as { social_token?: unknown })?.social_token;
    if (typeof token !== 'string' || token.length === 0) {
      this.fail({ message: 'missing_social_token' }, 400);
      return;
    }

    verifyGoogleIdToken(token)
      .then((payload: GoogleIdTokenPayload) => this.success(payload))
      .catch((err: Error) => this.error(err));
  }
}
