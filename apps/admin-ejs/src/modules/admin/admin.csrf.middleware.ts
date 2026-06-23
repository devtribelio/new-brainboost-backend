import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '@bb/common/config/env';
import { ForbiddenException } from '@bb/common/exceptions';

// Stateless double-submit CSRF protection for the cookie-authenticated admin.
// A random token is stored in a cookie; state-changing requests must echo the
// same value back via a hidden `_csrf` form field or an `x-csrf-token` header.
// A cross-site attacker can neither read the cookie nor forge a matching token,
// so the two never line up. This is defence-in-depth on top of the auth
// cookie's `sameSite=lax`.
//
// Split into two stages so the issue step can run ahead of auth (every rendered
// form — including the login page — needs a token in res.locals) while the
// verify step runs *after* adminAuthGuard, so an unauthenticated POST still
// redirects to /login (302) instead of failing CSRF (403).
const CSRF_COOKIE = 'bb_admin_csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function readSubmittedToken(req: Request): string | null {
  const fromBody = (req.body as Record<string, unknown> | undefined)?._csrf;
  if (typeof fromBody === 'string' && fromBody) return fromBody;
  const header = req.get('x-csrf-token') ?? req.get('x-xsrf-token');
  return header && header.length > 0 ? header : null;
}

function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch — guard first.
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Seed the CSRF cookie (once) and expose the token to views. Never blocks. */
export function csrfIssue(req: Request, res: Response, next: NextFunction): void {
  let token = req.cookies?.[CSRF_COOKIE] as string | undefined;
  if (!token) {
    token = randomBytes(32).toString('hex');
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: false, // readable by same-origin fetch callers (e.g. curation actions)
      sameSite: 'lax',
      secure: env.isProduction,
      path: '/',
    });
  }
  res.locals.csrfToken = token;
  next();
}

/** Reject state-changing requests whose submitted token doesn't match the cookie. */
export function csrfVerify(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const cookieToken = req.cookies?.[CSRF_COOKIE] as string | undefined;
  const submitted = readSubmittedToken(req);
  if (!cookieToken || !submitted || !tokensMatch(submitted, cookieToken)) {
    throw new ForbiddenException('Invalid or missing CSRF token');
  }
  next();
}
