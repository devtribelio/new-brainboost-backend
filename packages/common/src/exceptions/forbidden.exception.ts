import { HttpException } from './http.exception';
import { ERROR_CODES, type ErrorCode } from './error-codes';

export class ForbiddenException extends HttpException {
  constructor(message = 'Forbidden', details?: unknown, code: ErrorCode = ERROR_CODES.FORBIDDEN) {
    super(403, code, message, details);
  }
}
