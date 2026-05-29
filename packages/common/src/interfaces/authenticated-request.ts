import type { Request } from 'express';
import type { TokenScope } from '@bb/common/utils/jwt.util';

export interface AuthenticatedUser {
  id: string;
  email: string;
  scope: TokenScope;
  sessionId?: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}
