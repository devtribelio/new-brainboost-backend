export interface PaginationParams {
  page: number;
  perPage: number;
  skip: number;
  take: number;
}

export function parsePagination(
  query: Record<string, unknown>,
  defaults: { perPage?: number; maxPerPage?: number } = {},
): PaginationParams {
  const defaultPerPage = defaults.perPage ?? 20;
  const maxPerPage = defaults.maxPerPage ?? 100;
  const rawPage = Number.parseInt(String(query.page ?? '1'), 10);
  const rawPerPage = Number.parseInt(String(query.perPage ?? defaultPerPage), 10);

  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const perPage =
    Number.isFinite(rawPerPage) && rawPerPage > 0 ? Math.min(rawPerPage, maxPerPage) : defaultPerPage;

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

export interface LegacyPage<T> {
  total: number;
  totalAll?: number;
  perPage: number;
  currentPage: number;
  lastPage: number;
  items: T[];
}

export function buildLegacyPage<T>(
  rows: T[],
  total: number,
  params: PaginationParams,
  totalAll?: number,
): LegacyPage<T> {
  return {
    total,
    ...(totalAll !== undefined ? { totalAll } : {}),
    perPage: params.perPage,
    currentPage: params.page,
    lastPage: Math.max(1, Math.ceil(total / params.perPage)),
    items: rows,
  };
}
