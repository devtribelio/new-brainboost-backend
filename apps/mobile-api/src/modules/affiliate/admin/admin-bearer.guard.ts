import type { RequestHandler } from 'express';
import jwt, { type VerifyOptions } from 'jsonwebtoken';
import { env } from '@bb/common/config/env';
import { prisma } from '@bb/db';
import { UnauthorizedException } from '@bb/common/exceptions';
import { REQUIRES_BEARER_AUTH } from '@bb/common/openapi/types';

/**
 * Bearer-token admin guard for the JSON admin endpoints exposed by mobile-api.
 *
 * The EJS admin app (apps/admin-ejs) authenticates staff with a COOKIE-based JWT
 * (`bb_admin`) signed with `env.admin.jwtSecret` using HS256. Rather than couple
 * mobile-api to that app, this guard verifies the SAME admin JWT presented as an
 * `Authorization: Bearer <token>` header, then confirms the admin row is active.
 * This reuses the existing Admin table + secret with zero cross-app imports.
 *
 * To call these endpoints, a staff member obtains an admin JWT (the value of the
 * `bb_admin` cookie after logging into the EJS admin, or any token signed with
 * ADMIN_JWT_SECRET / HS256 carrying `{ sub, email, role }`) and sends it as a
 * bearer token. Algorithm is pinned to HS256 (guards alg-confusion).
 */
const ALGORITHM = 'HS256' as const;

interface AdminTokenPayload {
  sub: string;
  email: string;
  role: string;
}

export interface AdminAuthedRequest extends Express.Request {
  admin?: { id: string; email: string; role: string };
}

export const adminBearerGuard: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.header('authorization') ?? req.header('Authorization');
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      return next(new UnauthorizedException('Missing admin bearer token'));
    }
    const token = header.slice(7).trim();
    const opts: VerifyOptions = { algorithms: [ALGORITHM] };
    let payload: AdminTokenPayload;
    try {
      payload = jwt.verify(token, env.admin.jwtSecret, opts) as AdminTokenPayload;
    } catch {
      return next(new UnauthorizedException('Invalid or expired admin token'));
    }

    const admin = await prisma.admin.findUnique({ where: { id: payload.sub } });
    if (!admin || !admin.isActive) {
      return next(new UnauthorizedException('Admin not found or inactive'));
    }

    (req as unknown as { admin: { id: string; email: string; role: string } }).admin = {
      id: admin.id,
      email: admin.email,
      role: admin.role,
    };
    return next();
  } catch (err) {
    return next(err);
  }
};

// Surface as bearer-secured in the OpenAPI registry (same flag authGuard uses).
(adminBearerGuard as unknown as Record<symbol, boolean>)[REQUIRES_BEARER_AUTH] = true;
