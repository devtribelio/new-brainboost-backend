import jwt, { type SignOptions, type VerifyOptions } from 'jsonwebtoken';
import { env } from '@bb/common/config/env';
import { UnauthorizedException } from '@bb/common/exceptions';
import type { AdminRole } from '@prisma/client';

/** Pinned signing/verification algorithm — guards against alg-confusion (alg:none / RS256→HS256). */
const ALGORITHM = 'HS256' as const;

export interface AdminTokenPayload {
  sub: string;
  email: string;
  role: AdminRole;
}

export function signAdminToken(payload: AdminTokenPayload): string {
  const opts: SignOptions = {
    algorithm: ALGORITHM,
    expiresIn: env.admin.jwtTtl as SignOptions['expiresIn'],
  };
  return jwt.sign(payload, env.admin.jwtSecret, opts);
}

export function verifyAdminToken(token: string): AdminTokenPayload {
  const opts: VerifyOptions = { algorithms: [ALGORITHM] };
  try {
    return jwt.verify(token, env.admin.jwtSecret, opts) as AdminTokenPayload;
  } catch {
    throw new UnauthorizedException('Invalid or expired admin token');
  }
}
