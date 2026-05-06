import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '@/config/env';
import { UnauthorizedException } from '@/common/exceptions';
import type { AdminRole } from '@prisma/client';

export interface AdminTokenPayload {
  sub: string;
  email: string;
  role: AdminRole;
}

export function signAdminToken(payload: AdminTokenPayload): string {
  const opts: SignOptions = {
    expiresIn: env.admin.jwtTtl as SignOptions['expiresIn'],
  };
  return jwt.sign(payload, env.admin.jwtSecret, opts);
}

export function verifyAdminToken(token: string): AdminTokenPayload {
  try {
    return jwt.verify(token, env.admin.jwtSecret) as AdminTokenPayload;
  } catch {
    throw new UnauthorizedException('Invalid or expired admin token');
  }
}
