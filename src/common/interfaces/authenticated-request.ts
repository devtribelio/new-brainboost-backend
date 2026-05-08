import type { Request } from 'express';
import type { TokenScope } from '@/common/utils/jwt.util';

export interface AuthenticatedUser {
  id: string;
  email: string;
  scope: TokenScope;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}
