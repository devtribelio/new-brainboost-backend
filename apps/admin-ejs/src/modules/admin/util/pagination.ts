import type { Request } from 'express';

export interface Pagination {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export function getPagination(req: Request): Pagination {
  const page = Math.max(1, Number.parseInt((req.query.page as string) ?? '1', 10) || 1);
  const rawSize = Number.parseInt((req.query.pageSize as string) ?? '', 10) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, rawSize));
  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    take: pageSize,
  };
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
}

export function buildPageMeta(p: Pagination, total: number): PageMeta {
  const totalPages = Math.max(1, Math.ceil(total / p.pageSize));
  return {
    page: p.page,
    pageSize: p.pageSize,
    total,
    totalPages,
    hasPrev: p.page > 1,
    hasNext: p.page < totalPages,
  };
}
