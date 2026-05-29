import { HttpException } from './http.exception';

export class NotFoundException extends HttpException {
  constructor(message = 'Not Found', details?: unknown) {
    super(404, 'NOT_FOUND', message, details);
  }
}
