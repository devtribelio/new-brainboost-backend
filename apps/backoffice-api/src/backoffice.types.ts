import type { Request } from 'express';

/** Authenticated backoffice operator, attached by the (future) bearer + RBAC guard. */
export interface BackofficePrincipal {
  adminId: string;
  role: 'SUPERADMIN' | 'ADMIN' | 'SUPPORT' | 'FINANCE';
}

export interface BackofficeRequest extends Request {
  principal?: BackofficePrincipal;
}
