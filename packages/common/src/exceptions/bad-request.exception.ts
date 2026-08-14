import { HttpException } from './http.exception';
import { ERROR_CODES, type ErrorCode } from './error-codes';

export class BadRequestException extends HttpException {
  constructor(
    message = 'Bad Request',
    details?: unknown,
    code: ErrorCode = ERROR_CODES.BAD_REQUEST,
  ) {
    super(400, code, message, details);
  }
}
