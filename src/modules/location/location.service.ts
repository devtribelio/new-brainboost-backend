import { prisma } from '@/config/prisma';
import type { PaginationParams } from '@/common/utils/pagination.util';

interface LocationQuery {
  keyword?: string;
}

export class LocationService {
  async listCountries(p: PaginationParams, q: LocationQuery) {
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

  async listProvinces(p: PaginationParams, q: LocationQuery & { countryLegacyId?: number }) {
    const where: Record<string, unknown> = {};
    if (q.keyword) where.name = { contains: q.keyword, mode: 'insensitive' };
    if (q.countryLegacyId) {
      const country = await prisma.country.findUnique({ where: { legacyId: q.countryLegacyId } });
      if (!country) return { rows: [], total: 0 };
      where.countryId = country.id;
    }
    const [rows, total] = await Promise.all([
      prisma.province.findMany({ where, orderBy: { name: 'asc' }, skip: p.skip, take: p.take }),
      prisma.province.count({ where }),
    ]);
    return { rows, total };
  }

  async listCities(p: PaginationParams, q: LocationQuery & { provinceLegacyId?: number }) {
    const where: Record<string, unknown> = {};
    if (q.keyword) where.name = { contains: q.keyword, mode: 'insensitive' };
    if (q.provinceLegacyId) {
      const prov = await prisma.province.findUnique({ where: { legacyId: q.provinceLegacyId } });
      if (!prov) return { rows: [], total: 0 };
      where.provinceId = prov.id;
    }
    const [rows, total] = await Promise.all([
      prisma.city.findMany({ where, orderBy: { name: 'asc' }, skip: p.skip, take: p.take }),
      prisma.city.count({ where }),
    ]);
    return { rows, total };
  }

  async listDistricts(p: PaginationParams, q: LocationQuery & { cityLegacyId?: number }) {
    const where: Record<string, unknown> = {};
    if (q.keyword) where.name = { contains: q.keyword, mode: 'insensitive' };
    if (q.cityLegacyId) {
      const city = await prisma.city.findUnique({ where: { legacyId: q.cityLegacyId } });
      if (!city) return { rows: [], total: 0 };
      where.cityId = city.id;
    }
    const [rows, total] = await Promise.all([
      prisma.district.findMany({ where, orderBy: { name: 'asc' }, skip: p.skip, take: p.take }),
      prisma.district.count({ where }),
    ]);
    return { rows, total };
  }
}
