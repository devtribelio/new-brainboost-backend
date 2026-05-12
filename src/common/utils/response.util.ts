import type { Response } from 'express';

export interface ApiEnvelope<T> {
  errCode: number;
  errMessage: string | null;
  data: T | null;
}

export function ok<T>(res: Response, data: T, status = 200): Response {
  const body: ApiEnvelope<T> = { errCode: 0, errMessage: null, data };
  return res.status(status).json(body);
}

export function fail(res: Response, status: number, message: string): Response {
  const body: ApiEnvelope<null> = { errCode: status, errMessage: message, data: null };
  return res.status(status).json(body);
}

export function notImplemented(res: Response, name?: string): Response {
  return fail(res, 501, name ? `Not Implemented: ${name}` : 'Not Implemented');
}
