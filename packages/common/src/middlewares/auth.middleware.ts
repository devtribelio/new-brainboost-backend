import type { Response, NextFunction, RequestHandler } from 'express';
import { UnauthorizedException } from '@bb/common/exceptions';
import { verifyAccessToken } from '@bb/common/utils/jwt.util';
import type { AuthenticatedRequest } from '@bb/common/interfaces/authenticated-request';
import { prisma } from '@bb/db';
import { REQUIRES_BEARER_AUTH } from '@bb/common/openapi/types';

async function assertSessionActive(sid: string | undefined): Promise<void> {
  if (!sid) {
    throw new UnauthorizedException('Session terminated — login again');
  }
  const row = await prisma.refreshToken.findUnique({
    where: { id: sid },
    select: { revokedAt: true },
  });
  if (!row || row.revokedAt) {
    throw new UnauthorizedException('Session terminated — login again');
  }
}

export const authGuard: RequestHandler = async (req, _res: Response, next: NextFunction) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice(7).trim();
    if (!token) throw new UnauthorizedException('Missing bearer token');

    const payload = verifyAccessToken(token);
    const scope = payload.scope ?? 'member';
    if (scope !== 'member') throw new UnauthorizedException('Member access token required');
    await assertSessionActive(payload.sid);
    (req as AuthenticatedRequest).user = {
      id: payload.sub,
      email: payload.email,
      scope,
      sessionId: payload.sid,
    };
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Like `authGuard` but skips the session-active DB check. Use only for endpoints
 * that must remain callable after the member's session was revoked (e.g. logout
 * cleanup: FCM deregister, refresh-row revocation, local-state confirmation).
 * Still requires valid JWT signature and member scope.
 */
export const authGuardLenient: RequestHandler = (req, _res: Response, next: NextFunction) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice(7).trim();
    if (!token) throw new UnauthorizedException('Missing bearer token');

    const payload = verifyAccessToken(token);
    const scope = payload.scope ?? 'member';
    if (scope !== 'member') throw new UnauthorizedException('Member access token required');
    (req as AuthenticatedRequest).user = {
      id: payload.sub,
      email: payload.email,
      scope,
      sessionId: payload.sid,
    };
    next();
  } catch (err) {
    next(err);
  }
};

export const optionalAuthGuard: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith('bearer ')) return next();
  const token = header.slice(7).trim();
  if (!token) return next();
  try {
    const payload = verifyAccessToken(token);
    const scope = payload.scope ?? 'member';
    if (scope === 'member') {
      await assertSessionActive(payload.sid);
    }
    (req as AuthenticatedRequest).user = {
      id: payload.sub,
      email: payload.email,
      scope,
      sessionId: payload.sid,
    };
  } catch {
    // silently ignore invalid token in optional mode
  }
  next();
};

export const anonOrMemberGuard: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice(7).trim();
    if (!token) throw new UnauthorizedException('Missing bearer token');

    const payload = verifyAccessToken(token);
    const scope = payload.scope ?? 'member';
    if (scope === 'member') {
      await assertSessionActive(payload.sid);
    }
    (req as AuthenticatedRequest).user = {
      id: payload.sub,
      email: payload.email,
      scope,
      sessionId: payload.sid,
    };
    next();
  } catch (err) {
    next(err);
  }
};

(authGuard as unknown as Record<symbol, boolean>)[REQUIRES_BEARER_AUTH] = true;
(authGuardLenient as unknown as Record<symbol, boolean>)[REQUIRES_BEARER_AUTH] = true;
(optionalAuthGuard as unknown as Record<symbol, boolean>)[REQUIRES_BEARER_AUTH] = true;
(anonOrMemberGuard as unknown as Record<symbol, boolean>)[REQUIRES_BEARER_AUTH] = true;
