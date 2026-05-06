import { HttpException } from './http.exception';

export class BadRequestException extends HttpException {
  constructor(message = 'Bad Request', details?: unknown) {
    super(400, message, details);
  }
}
