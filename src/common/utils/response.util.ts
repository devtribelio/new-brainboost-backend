import type { Response } from 'express';

export interface Pagination {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export type Meta = Record<string, unknown> & { pagination?: Pagination };

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiEnvelope<T> {
  success: boolean;
  data: T | null;
  meta: Meta | null;
  error: ApiError | null;
}

export function ok<T>(res: Response, data: T, meta?: Meta, status = 200): Response {
  const body: ApiEnvelope<T> = {
    success: true,
    data,
    meta: meta ?? null,
    error: null,
  };
  return res.status(status).json(body);
}

export function okCreated<T>(res: Response, data: T, meta?: Meta): Response {
  return ok(res, data, meta, 201);
}

export function okPaginated<T>(
  res: Response,
  items: T[],
  pagination: { page: number; perPage: number; total: number },
  extraMeta?: Omit<Meta, 'pagination'>,
): Response {
  const totalPages = Math.max(1, Math.ceil(pagination.total / Math.max(1, pagination.perPage)));
  const meta: Meta = {
    ...(extraMeta ?? {}),
    pagination: {
      page: pagination.page,
      perPage: pagination.perPage,
      total: pagination.total,
      totalPages,
    },
  };
  return ok(res, items, meta);
}

export function fail(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response {
  const body: ApiEnvelope<null> = {
    success: false,
    data: null,
    meta: null,
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  };
  return res.status(status).json(body);
}

export function notImplemented(res: Response, name?: string): Response {
  return fail(
    res,
    501,
    'NOT_IMPLEMENTED',
    name ? `Not Implemented: ${name}` : 'Not Implemented',
  );
}
