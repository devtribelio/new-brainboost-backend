import type { ErrorRequestHandler, Request, Response, NextFunction, RequestHandler } from 'express';
import { HttpException } from '@/common/exceptions';
import { fail } from '@/common/utils/response.util';
import { logger } from '@/config/logger';
import { env } from '@/config/env';

function isAdminRequest(req: Request): boolean {
  return req.originalUrl.startsWith('/admin');
}

function renderAdminError(res: Response, status: number, message: string): void {
  res.status(status).render('admin/error', {
    admin: null,
    sidebar: [],
    flash: null,
    currentPath: '',
    title: `Error ${status}`,
    status,
    message,
  });
}

function statusToCode(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'UNPROCESSABLE_ENTITY';
    case 429:
      return 'TOO_MANY_REQUESTS';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'ERROR';
  }
}

export const errorHandler: ErrorRequestHandler = (err, req: Request, res: Response, _next: NextFunction) => {
  const isHttp = err instanceof HttpException;
  const status = isHttp ? err.status : 500;
  const message = isHttp ? err.message : 'Internal Server Error';
  const code = isHttp ? err.code : statusToCode(status);

  if (!isHttp) {
    logger.error({ err }, 'Unhandled error');
  }

  if (isAdminRequest(req)) {
    renderAdminError(res, status, message);
    return;
  }

  let details: unknown = isHttp ? err.details : undefined;
  if (!env.isProduction && !isHttp) {
    details = {
      error: (err as Error)?.message,
      stack: (err as Error)?.stack?.split('\n').slice(0, 8),
    };
  }

  fail(res, status, code, message, details);
};

export const notFoundHandler: RequestHandler = (req, res) => {
  const message = `Route not found: ${req.method} ${req.originalUrl}`;
  if (isAdminRequest(req)) {
    renderAdminError(res, 404, message);
    return;
  }
  fail(res, 404, 'NOT_FOUND', message);
};
