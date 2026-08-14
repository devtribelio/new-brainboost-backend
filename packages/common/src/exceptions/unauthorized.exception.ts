import { HttpException } from './http.exception';
import { ERROR_CODES, type ErrorCode } from './error-codes';

export class UnauthorizedException extends HttpException {
  constructor(
    message = 'Unauthorized',
    details?: unknown,
    code: ErrorCode = ERROR_CODES.UNAUTHORIZED,
  ) {
    super(401, code, message, details);
  }
}
