import type { Request } from 'express';
import type { AdminRole } from '@prisma/client';

export interface AdminPrincipal {
  id: string;
  email: string;
  role: AdminRole;
  fullName?: string;
}

export interface AdminRequest extends Request {
  admin?: AdminPrincipal;
}
