import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { env } from '@bb/common/config/env';
import { signAdminToken } from './admin.jwt.util';
import { setFlash, consumeFlash } from './util/flash';

export class AdminAuthController {
  loginPage = (req: Request, res: Response) => {
    res.render('admin/login', {
      title: 'Admin Login',
      flash: consumeFlash(req, res),
      email: '',
    });
  };

  login = async (req: Request, res: Response) => {
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const password = String(req.body.password ?? '');

    if (!email || !password) {
      return res.status(400).render('admin/login', {
        title: 'Admin Login',
        flash: { level: 'error', text: 'Email and password are required.' },
        email,
      });
    }

    const admin = await prisma.admin.findUnique({ where: { email } });
    if (!admin || !admin.isActive) {
      return res.status(401).render('admin/login', {
        title: 'Admin Login',
        flash: { level: 'error', text: 'Invalid credentials.' },
        email,
      });
    }

    const matches = await bcrypt.compare(password, admin.passwordHash);
    if (!matches) {
      return res.status(401).render('admin/login', {
        title: 'Admin Login',
        flash: { level: 'error', text: 'Invalid credentials.' },
        email,
      });
    }

    await prisma.admin.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    const token = signAdminToken({ sub: admin.id, email: admin.email, role: admin.role });
    res.cookie(env.admin.cookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.isProduction,
      path: '/',
      maxAge: 8 * 60 * 60 * 1000,
    });
    setFlash(res, 'success', `Welcome back, ${admin.fullName}.`);
    return res.redirect('/admin');
  };

  logout = (_req: Request, res: Response) => {
    res.clearCookie(env.admin.cookieName, { path: '/' });
    res.redirect('/admin/login');
  };
}
