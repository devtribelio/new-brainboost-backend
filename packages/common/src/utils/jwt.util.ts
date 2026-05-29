import jwt, { type SignOptions, type VerifyOptions } from 'jsonwebtoken';
import { env } from '@bb/common/config/env';
import { UnauthorizedException } from '@bb/common/exceptions';

/** Pinned signing/verification algorithm — guards against alg-confusion (alg:none / RS256→HS256). */
const ALGORITHM = 'HS256' as const;

export type TokenScope = 'member' | 'anon';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  scope?: TokenScope;
  /** Session id = RefreshToken.id. Bound on member-scope tokens; absent on anon. */
  sid?: string;
}

export interface RefreshTokenPayload {
  sub: string;
  tokenId: string;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  const opts: SignOptions = {
    algorithm: ALGORITHM,
    expiresIn: env.jwt.accessExpiresIn as SignOptions['expiresIn'],
  };
  return jwt.sign({ ...payload, scope: payload.scope ?? 'member' }, env.jwt.accessSecret, opts);
}

export function signAnonAccessToken(clientId: string): string {
  const opts: SignOptions = {
    algorithm: ALGORITHM,
    expiresIn: env.jwt.anonExpiresIn as SignOptions['expiresIn'],
  };
  return jwt.sign({ sub: clientId, email: '', scope: 'anon' }, env.jwt.accessSecret, opts);
}

export function signRefreshToken(payload: RefreshTokenPayload): string {
  const opts: SignOptions = {
    algorithm: ALGORITHM,
    expiresIn: env.jwt.refreshExpiresIn as SignOptions['expiresIn'],
  };
  return jwt.sign(payload, env.jwt.refreshSecret, opts);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const opts: VerifyOptions = { algorithms: [ALGORITHM] };
  try {
    return jwt.verify(token, env.jwt.accessSecret, opts) as AccessTokenPayload;
  } catch {
    throw new UnauthorizedException('Invalid or expired access token');
  }
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const opts: VerifyOptions = { algorithms: [ALGORITHM] };
  try {
    return jwt.verify(token, env.jwt.refreshSecret, opts) as RefreshTokenPayload;
  } catch {
    throw new UnauthorizedException('Invalid or expired refresh token');
  }
}
