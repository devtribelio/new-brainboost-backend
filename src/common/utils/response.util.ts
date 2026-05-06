import type { Response } from 'express';

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiError {
  success: false;
  error: {
    message: string;
    details?: unknown;
  };
}

export function ok<T>(res: Response, data: T, meta?: Record<string, unknown>, status = 200): Response {
  const body: ApiSuccess<T> = { success: true, data };
  if (meta) body.meta = meta;
  return res.status(status).json(body);
}

export function fail(res: Response, status: number, message: string, details?: unknown): Response {
  const body: ApiError = { success: false, error: { message } };
  if (details !== undefined) body.error.details = details;
  return res.status(status).json(body);
}

export function notImplemented(res: Response, name?: string): Response {
  return fail(res, 501, name ? `Not Implemented: ${name}` : 'Not Implemented');
}
