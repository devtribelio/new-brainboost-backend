export interface PaginationParams {
  page: number;
  perPage: number;
  skip: number;
  take: number;
}

export function parsePagination(query: Record<string, unknown>): PaginationParams {
  const rawPage = Number.parseInt(String(query.page ?? '1'), 10);
  const rawPerPage = Number.parseInt(String(query.perPage ?? '20'), 10);

  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const perPage = Number.isFinite(rawPerPage) && rawPerPage > 0 ? Math.min(rawPerPage, 100) : 20;

  return { page, perPage, skip: (page - 1) * perPage, take: perPage };
}

export function buildPageMeta(total: number, params: PaginationParams) {
  return {
    page: params.page,
    perPage: params.perPage,
    total,
    totalPages: Math.max(1, Math.ceil(total / params.perPage)),
  };
}
