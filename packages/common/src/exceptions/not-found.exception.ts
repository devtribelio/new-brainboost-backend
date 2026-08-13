import { HttpException } from './http.exception';
import { ERROR_CODES, type ErrorCode } from './error-codes';

export class NotFoundException extends HttpException {
  constructor(message = 'Not Found', details?: unknown, code: ErrorCode = ERROR_CODES.NOT_FOUND) {
    super(404, code, message, details);
  }
}
