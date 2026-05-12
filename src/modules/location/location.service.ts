import { prisma } from '@/config/prisma';
import type { PaginationParams } from '@/common/utils/pagination.util';

interface LocationQuery {
  keyword?: string;
}

async function resolveLegacyOrId<T extends { id: string }>(
  finder: (where: { legacyId: number } | { id: string }) => Promise<T | null>,
  input: string,
): Promise<T | null> {
  const legacyId = Number.parseInt(input, 10);
  if (Number.isFinite(legacyId) && input === String(legacyId)) {
    const byLegacy = await finder({ legacyId });
    if (byLegacy) return byLegacy;
  }
  return finder({ id: input });
}

const provinceInclude = { country: { select: { legacyId: true } } } as const;
const cityInclude = {
  province: {
    select: { legacyId: true, country: { select: { legacyId: true } } },
  },
} as const;
const districtInclude = {
  city: {
    select: {
      legacyId: true,
      province: {
        select: { legacyId: true, country: { select: { legacyId: true } } },
      },
    },
  },
} as const;

export class LocationService {
  async listCountries(p: PaginationParams, q: LocationQuery & { countryId?: string }) {
    if (q.countryId) {
      const single = await resolveLegacyOrId<{ id: string }>(
        (where) => prisma.country.findUnique({ where: where as any }),
        q.countryId,
      );
      if (!single) return { rows: [], total: 0 };
      const full = await prisma.country.findUnique({ where: { id: single.id } });
      return { rows: full ? [full] : [], total: full ? 1 : 0 };
    }
    const where = q.keyword
      ? { name: { contains: q.keyword, mode: 'insensitive' as const } }
      : {};
    const [rows, total] = await Promise.all([
      prisma.country.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: p.skip,
        take: p.take,
      }),
      prisma.country.count({ where }),
    ]);
    return { rows, total };
  }

  async listProvinces(
    p: PaginationParams,
    q: LocationQuery & { countryLegacyId?: number; provinceId?: string },
  ) {
    if (q.provinceId) {
      const single = await resolveLegacyOrId<{ id: string }>(
        (where) => prisma.province.findUnique({ where: where as any }),
        q.provinceId,
      );
      if (!single) return { rows: [], total: 0 };
      const full = await prisma.province.findUnique({
        where: { id: single.id },
        include: provinceInclude,
      });
      return { rows: full ? [full] : [], total: full ? 1 : 0 };
    }
    const where: Record<string, unknown> = {};
    if (q.keyword) where.name = { contains: q.keyword, mode: 'insensitive' };
    if (q.countryLegacyId) {
      const country = await prisma.country.findUnique({ where: { legacyId: q.countryLegacyId } });
      if (!country) return { rows: [], total: 0 };
      where.countryId = country.id;
    }
    const [rows, total] = await Promise.all([
      prisma.province.findMany({
        where,
        include: provinceInclude,
        orderBy: { name: 'asc' },
        skip: p.skip,
        take: p.take,
      }),
      prisma.province.count({ where }),
    ]);
    return { rows, total };
  }

  async listCities(
    p: PaginationParams,
    q: LocationQuery & {
      countryLegacyId?: number;
      provinceLegacyId?: number;
      cityId?: string;
    },
  ) {
    if (q.cityId) {
      const single = await resolveLegacyOrId<{ id: string }>(
        (where) => prisma.city.findUnique({ where: where as any }),
        q.cityId,
      );
      if (!single) return { rows: [], total: 0 };
      const full = await prisma.city.findUnique({
        where: { id: single.id },
        include: cityInclude,
      });
      return { rows: full ? [full] : [], total: full ? 1 : 0 };
    }
    const where: Record<string, unknown> = {};
    if (q.keyword) where.name = { contains: q.keyword, mode: 'insensitive' };
    if (q.provinceLegacyId) {
      const prov = await prisma.province.findUnique({ where: { legacyId: q.provinceLegacyId } });
      if (!prov) return { rows: [], total: 0 };
      where.provinceId = prov.id;
    } else if (q.countryLegacyId) {
      // Country-only filter — match cities whose province belongs to country.
      const country = await prisma.country.findUnique({ where: { legacyId: q.countryLegacyId } });
      if (!country) return { rows: [], total: 0 };
      where.province = { countryId: country.id };
    }
    const [rows, total] = await Promise.all([
      prisma.city.findMany({
        where,
        include: cityInclude,
        orderBy: { name: 'asc' },
        skip: p.skip,
        take: p.take,
      }),
      prisma.city.count({ where }),
    ]);
    return { rows, total };
  }

  async listDistricts(
    p: PaginationParams,
    q: LocationQuery & {
      countryLegacyId?: number;
      provinceLegacyId?: number;
      cityLegacyId?: number;
      districtId?: string;
    },
  ) {
    if (q.districtId) {
      const single = await resolveLegacyOrId<{ id: string }>(
        (where) => prisma.district.findUnique({ where: where as any }),
        q.districtId,
      );
      if (!single) return { rows: [], total: 0 };
      const full = await prisma.district.findUnique({
        where: { id: single.id },
        include: districtInclude,
      });
      return { rows: full ? [full] : [], total: full ? 1 : 0 };
    }
    const where: Record<string, unknown> = {};
    if (q.keyword) where.name = { contains: q.keyword, mode: 'insensitive' };
    if (q.cityLegacyId) {
      const city = await prisma.city.findUnique({ where: { legacyId: q.cityLegacyId } });
      if (!city) return { rows: [], total: 0 };
      where.cityId = city.id;
    } else if (q.provinceLegacyId) {
      const prov = await prisma.province.findUnique({ where: { legacyId: q.provinceLegacyId } });
      if (!prov) return { rows: [], total: 0 };
      where.city = { provinceId: prov.id };
    } else if (q.countryLegacyId) {
      const country = await prisma.country.findUnique({ where: { legacyId: q.countryLegacyId } });
      if (!country) return { rows: [], total: 0 };
      where.city = { province: { countryId: country.id } };
    }
    const [rows, total] = await Promise.all([
      prisma.district.findMany({
        where,
        include: districtInclude,
        orderBy: { name: 'asc' },
        skip: p.skip,
        take: p.take,
      }),
      prisma.district.count({ where }),
    ]);
    return { rows, total };
  }
}
