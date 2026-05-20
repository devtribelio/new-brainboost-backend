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

export function buildPagination(input: { page: number; perPage: number; total: number }) {
  return {
    page: input.page,
    perPage: input.perPage,
    total: input.total,
    totalPages: Math.max(1, Math.ceil(input.total / Math.max(1, input.perPage))),
  };
}
