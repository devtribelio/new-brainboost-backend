import { HttpException } from './http.exception';

export class BadRequestException extends HttpException {
  constructor(message = 'Bad Request', details?: unknown, code = 'BAD_REQUEST') {
    super(400, code, message, details);
  }
}
