import type { ErrorRequestHandler, Request, Response, NextFunction, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { HttpException } from '@bb/common/exceptions';
import { fail } from '@bb/common/utils/response.util';
import { logger } from '@bb/common/config/logger';
import { env } from '@bb/common/config/env';

interface MappedError {
  status: number;
  code: string;
  message: string;
}

// Map raw Prisma errors to clean client responses. Without this a bad UUID
// (P2023) or missing row (P2025) leaks the full Prisma invocation + stack as a
// 500. Returns null for anything not recognised — caller falls back to 500.
function mapPrismaError(err: unknown): MappedError | null {
  if (err instanceof Prisma.PrismaClientValidationError) {
    return { status: 400, code: 'BAD_REQUEST', message: 'Invalid request parameters' };
  }
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return null;
  switch (err.code) {
    case 'P2023': // malformed id (e.g. non-UUID passed to a Uuid column)
    case 'P2000': // value too long for column
      return { status: 400, code: 'BAD_REQUEST', message: 'Invalid request parameters' };
    case 'P2002': // unique constraint violation
      return { status: 409, code: 'CONFLICT', message: 'Resource already exists' };
    case 'P2003': // foreign key constraint violation
      return { status: 400, code: 'BAD_REQUEST', message: 'Related resource is invalid' };
    case 'P2025': // record not found
      return { status: 404, code: 'NOT_FOUND', message: 'Resource not found' };
    default:
      return null;
  }
}

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

export const errorHandler: ErrorRequestHandler = (
  err,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const isHttp = err instanceof HttpException;
  const mapped = isHttp ? null : mapPrismaError(err);

  const status = isHttp ? err.status : (mapped?.status ?? 500);
  const message = isHttp ? err.message : (mapped?.message ?? 'Internal Server Error');
  const code = isHttp ? err.code : (mapped?.code ?? statusToCode(status));

  // Log full error for anything we didn't deliberately produce (HttpException)
  // or cleanly map. Mapped Prisma errors are expected client mistakes.
  if (!isHttp && !mapped) {
    logger.error({ err }, 'Unhandled error');
  } else if (mapped) {
    logger.warn({ err: (err as Error)?.message }, 'Mapped database error');
  }

  if (isAdminRequest(req)) {
    renderAdminError(res, status, message);
    return;
  }

  let details: unknown = isHttp ? err.details : undefined;
  // Expose raw error only in non-prod, and only for genuinely unhandled cases.
  if (!env.isProduction && !isHttp && !mapped) {
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
