import type { Request, RequestHandler } from 'express';
import { unauthorized, ERROR_CODES } from '@bb/common/exceptions';
import { credentialService, type VerifiedCredential } from './credential.service';

export interface CredentialedRequest extends Request {
  credential?: VerifiedCredential;
}

/**
 * Authenticate a 3rd-party ingestion call via `Authorization: Bearer <key>`.
 * Attaches the verified credential (incl. capability toggles) to the request.
 */
export const credentialGuard: RequestHandler = (req, _res, next) => {
  const auth = req.header('authorization') ?? '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  credentialService
    .verify(key)
    .then((cred) => {
      if (!cred) {
        next(unauthorized(ERROR_CODES.INGEST_CREDENTIAL_INVALID));
        return;
      }
      (req as CredentialedRequest).credential = cred;
      next();
    })
    .catch(next);
};
