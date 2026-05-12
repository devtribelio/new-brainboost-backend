import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '@/config/env';
import { UnauthorizedException } from '@/common/exceptions';

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
  const opts: SignOptions = { expiresIn: env.jwt.accessExpiresIn as SignOptions['expiresIn'] };
  return jwt.sign({ ...payload, scope: payload.scope ?? 'member' }, env.jwt.accessSecret, opts);
}

export function signAnonAccessToken(clientId: string): string {
  const opts: SignOptions = { expiresIn: env.jwt.anonExpiresIn as SignOptions['expiresIn'] };
  return jwt.sign({ sub: clientId, email: '', scope: 'anon' }, env.jwt.accessSecret, opts);
}

export function signRefreshToken(payload: RefreshTokenPayload): string {
  const opts: SignOptions = { expiresIn: env.jwt.refreshExpiresIn as SignOptions['expiresIn'] };
  return jwt.sign(payload, env.jwt.refreshSecret, opts);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    return jwt.verify(token, env.jwt.accessSecret) as AccessTokenPayload;
  } catch {
    throw new UnauthorizedException('Invalid or expired access token');
  }
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  try {
    return jwt.verify(token, env.jwt.refreshSecret) as RefreshTokenPayload;
  } catch {
    throw new UnauthorizedException('Invalid or expired refresh token');
  }
}
