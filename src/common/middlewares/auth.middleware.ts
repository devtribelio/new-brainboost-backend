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
    (req as AuthenticatedRequest).user = { id: payload.sub, email: payload.email };
    next();
  } catch (err) {
    next(err);
  }
};
