import type { ErrorRequestHandler, Request, Response, NextFunction, RequestHandler } from 'express';
import { HttpException } from '@/common/exceptions';
import { fail } from '@/common/utils/response.util';
import { logger } from '@/config/logger';

export const errorHandler: ErrorRequestHandler = (err, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpException) {
    return fail(res, err.status, err.message, err.details);
  }

  logger.error({ err }, 'Unhandled error');
  return fail(res, 500, 'Internal Server Error');
};

export const notFoundHandler: RequestHandler = (req, res) => {
  fail(res, 404, `Route not found: ${req.method} ${req.originalUrl}`);
};
