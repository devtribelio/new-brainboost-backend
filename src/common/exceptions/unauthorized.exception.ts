import { HttpException } from './http.exception';

export class UnauthorizedException extends HttpException {
  constructor(message = 'Unauthorized', details?: unknown) {
    super(401, message, details);
  }
}
