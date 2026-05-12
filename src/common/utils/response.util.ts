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

export interface LegacyMeta {
  total: number;
  page: number;
  lastPage: number;
}

export interface LegacyEnvelope<T> {
  meta: LegacyMeta;
  data: T[];
}

// FE legacy http layer expects {meta:{total,page,lastPage}, data:[]} — no errCode wrap.
// Used by /product/list, /data/location/*, /data/banner, /data/commisionSummary.
export function okLegacy<T>(
  res: Response,
  rows: T[],
  total: number,
  page: number,
  perPage: number,
  status = 200,
): Response {
  const lastPage = Math.max(1, Math.ceil(total / Math.max(1, perPage)));
  const body: LegacyEnvelope<T> = {
    meta: { total, page, lastPage },
    data: rows,
  };
  return res.status(status).json(body);
}
