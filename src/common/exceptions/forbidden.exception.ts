import { HttpException } from './http.exception';

export class ForbiddenException extends HttpException {
  constructor(message = 'Forbidden', details?: unknown) {
    super(403, 'FORBIDDEN', message, details);
  }
}
