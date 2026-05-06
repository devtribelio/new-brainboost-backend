import type { ErrorRequestHandler, Request, Response, NextFunction, RequestHandler } from 'express';
import { HttpException } from '@/common/exceptions';
import { fail } from '@/common/utils/response.util';
import { logger } from '@/config/logger';

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

export const errorHandler: ErrorRequestHandler = (err, req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpException ? err.status : 500;
  const message =
    err instanceof HttpException ? err.message : 'Internal Server Error';

  if (!(err instanceof HttpException)) {
    logger.error({ err }, 'Unhandled error');
  }

  if (isAdminRequest(req)) {
    renderAdminError(res, status, message);
    return;
  }

  fail(res, status, message, err instanceof HttpException ? err.details : undefined);
};

export const notFoundHandler: RequestHandler = (req, res) => {
  if (isAdminRequest(req)) {
    renderAdminError(res, 404, `Route not found: ${req.method} ${req.originalUrl}`);
    return;
  }
  fail(res, 404, `Route not found: ${req.method} ${req.originalUrl}`);
};
