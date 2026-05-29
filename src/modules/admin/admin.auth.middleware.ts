import type { Response, NextFunction, RequestHandler } from 'express';
import { env } from '@/config/env';
import { prisma } from '@bb/db';
import { verifyAdminToken } from './admin.jwt.util';
import type { AdminRequest } from './admin.types';

export const adminAuthGuard: RequestHandler = async (req, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.[env.admin.cookieName];
    if (!token) {
      return res.redirect('/admin/login');
    }
    const payload = verifyAdminToken(token);
    const admin = await prisma.admin.findUnique({ where: { id: payload.sub } });
    if (!admin || !admin.isActive) {
      res.clearCookie(env.admin.cookieName, { path: '/' });
      return res.redirect('/admin/login');
    }
    (req as AdminRequest).admin = {
      id: admin.id,
      email: admin.email,
      role: admin.role,
      fullName: admin.fullName,
    };
    return next();
  } catch {
    res.clearCookie(env.admin.cookieName, { path: '/' });
    return res.redirect('/admin/login');
  }
};

export function requireRole(...roles: Array<'SUPERADMIN' | 'ADMIN'>): RequestHandler {
  return (req, res, next) => {
    const admin = (req as AdminRequest).admin;
    if (!admin || !roles.includes(admin.role)) {
      res.status(403).render('admin/error', {
        admin: admin ?? null,
        sidebar: [],
        flash: null,
        currentPath: req.path,
        title: 'Forbidden',
        status: 403,
        message: 'You do not have permission to access this resource.',
      });
      return;
    }
    next();
  };
}
