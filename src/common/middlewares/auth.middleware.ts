import type { Response, NextFunction, RequestHandler } from 'express';
import { UnauthorizedException } from '@/common/exceptions';
import { verifyAccessToken } from '@/common/utils/jwt.util';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';

export const authGuard: RequestHandler = (req, _res: Response, next: NextFunction) => {
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
    (req as AuthenticatedRequest).user = { id: payload.sub, email: payload.email, scope };
    next();
  } catch (err) {
    next(err);
  }
};

export const optionalAuthGuard: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith('bearer ')) return next();
  const token = header.slice(7).trim();
  if (!token) return next();
  try {
    const payload = verifyAccessToken(token);
    (req as AuthenticatedRequest).user = {
      id: payload.sub,
      email: payload.email,
      scope: payload.scope ?? 'member',
    };
  } catch {
    // silently ignore invalid token in optional mode
  }
  next();
};

export const anonOrMemberGuard: RequestHandler = (req, _res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice(7).trim();
    if (!token) throw new UnauthorizedException('Missing bearer token');

    const payload = verifyAccessToken(token);
    (req as AuthenticatedRequest).user = {
      id: payload.sub,
      email: payload.email,
      scope: payload.scope ?? 'member',
    };
    next();
  } catch (err) {
    next(err);
  }
};
