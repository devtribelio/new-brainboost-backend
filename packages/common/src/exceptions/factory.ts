import { BadRequestException } from './bad-request.exception';
import { ForbiddenException } from './forbidden.exception';
import { NotFoundException } from './not-found.exception';
import { UnauthorizedException } from './unauthorized.exception';
import type { ErrorCode } from './error-codes';
import { messageFor } from './error-messages';

/**
 * Preferred way to raise an API error.
 *
 *     throw notFound(ERROR_CODES.POST_NOT_FOUND);
 *     throw badRequest(ERROR_CODES.POST_CONTENT_TOO_LONG, { max: MAX_CONTENT_CHARS });
 *
 * The factory decides the HTTP status, the code decides the user-facing copy
 * (from error-messages.ts). Because the copy is looked up rather than written at
 * the call site, one condition renders one sentence everywhere it is raised —
 * which is what lets the mobile client display `error.message` as-is.
 *
 * `details` is for the machine-readable extras a message must NOT contain:
 * limits, the offending input, current state. It reaches the client as
 * `error.details` and is meant for logs/diagnostics, not display.
 *
 * Construct the exception classes directly only when the copy genuinely cannot
 * come from a code (there should be no such case in normal request handling).
 */
export function badRequest(code: ErrorCode, details?: unknown): BadRequestException {
  return new BadRequestException(messageFor(code), details, code);
}

export function unauthorized(code: ErrorCode, details?: unknown): UnauthorizedException {
  return new UnauthorizedException(messageFor(code), details, code);
}

export function forbidden(code: ErrorCode, details?: unknown): ForbiddenException {
  return new ForbiddenException(messageFor(code), details, code);
}

export function notFound(code: ErrorCode, details?: unknown): NotFoundException {
  return new NotFoundException(messageFor(code), details, code);
}
