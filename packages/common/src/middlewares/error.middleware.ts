import type { ErrorRequestHandler, Request, Response, NextFunction, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { ERROR_CODES, HttpException, messageFor, type ErrorCode } from '@bb/common/exceptions';
import { fail } from '@bb/common/utils/response.util';
import { logger } from '@bb/common/config/logger';
import { env } from '@bb/common/config/env';

interface MappedError {
  status: number;
  code: ErrorCode;
  message: string;
}

// Map raw Prisma errors to clean client responses. Without this a bad UUID
// (P2023) or missing row (P2025) leaks the full Prisma invocation + stack as a
// 500. Returns null for anything not recognised — caller falls back to 500.
function mapped(status: number, code: ErrorCode): MappedError {
  return { status, code, message: messageFor(code) };
}

function mapPrismaError(err: unknown): MappedError | null {
  if (err instanceof Prisma.PrismaClientValidationError) {
    return mapped(400, ERROR_CODES.BAD_REQUEST);
  }
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return null;
  switch (err.code) {
    case 'P2023': // malformed id (e.g. non-UUID passed to a Uuid column)
    case 'P2000': // value too long for column
      return mapped(400, ERROR_CODES.BAD_REQUEST);
    case 'P2002': // unique constraint violation
      return mapped(409, ERROR_CODES.CONFLICT);
    case 'P2003': // foreign key constraint violation
      return mapped(400, ERROR_CODES.RELATED_RESOURCE_INVALID);
    case 'P2025': // record not found
      return mapped(404, ERROR_CODES.NOT_FOUND);
    default:
      return null;
  }
}

// Fallback code for errors that never passed through an HttpException (raw
// throws, unmapped Prisma failures). Deliberately coarse: a code derived from
// the status carries no information the status line didn't already give the
// client. Anything a client needs to BRANCH on must throw an HttpException with
// an explicit ERROR_CODES value instead — see exceptions/error-codes.ts.
function statusToCode(status: number): string {
  switch (status) {
    case 400:
      return ERROR_CODES.BAD_REQUEST;
    case 401:
      return ERROR_CODES.UNAUTHORIZED;
    case 403:
      return ERROR_CODES.FORBIDDEN;
    case 404:
      return ERROR_CODES.NOT_FOUND;
    case 409:
      return ERROR_CODES.CONFLICT;
    case 422:
      return ERROR_CODES.UNPROCESSABLE_ENTITY;
    case 429:
      return ERROR_CODES.TOO_MANY_REQUESTS;
    default:
      return status >= 500 ? ERROR_CODES.INTERNAL_ERROR : 'ERROR';
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
  const message = isHttp
    ? err.message
    : (mapped?.message ?? messageFor(ERROR_CODES.INTERNAL_ERROR));
  const code = isHttp ? err.code : (mapped?.code ?? statusToCode(status));

  // Log full error for anything we didn't deliberately produce (HttpException)
  // or cleanly map. Mapped Prisma errors are expected client mistakes.
  if (!isHttp && !mapped) {
    logger.error({ err }, 'Unhandled error');
  } else if (mapped) {
    logger.warn({ err: (err as Error)?.message }, 'Mapped database error');
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
  // The route the caller asked for goes in `details`, not in the message: the
  // message is user-facing copy, and echoing `originalUrl` reflects raw client
  // input back into the response body.
  fail(res, 404, ERROR_CODES.NOT_FOUND, messageFor(ERROR_CODES.NOT_FOUND), {
    method: req.method,
    path: req.originalUrl,
  });
};
