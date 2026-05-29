import type { City, Country, District, Province } from '@prisma/client';

// FE legacy http layer expects `{id: int, parent legacyIds, name}` per audit
// §49-52. `id` = legacyId, parent ids = parent's legacyId. Falls back to UUID
// string when legacyId is null (shouldn't happen in production data).

export function serializeCountry(c: Country): Record<string, unknown> {
  return {
    id: c.legacyId ?? c.id,
    name: c.name,
    code: c.code,
  };
}

interface ProvinceWithCountry extends Province {
  country?: { legacyId: number | null } | null;
}

export function serializeProvince(p: ProvinceWithCountry): Record<string, unknown> {
  return {
    id: p.legacyId ?? p.id,
    countryId: p.country?.legacyId ?? null,
    name: p.name,
  };
}

interface CityWithParents extends City {
  province?: { legacyId: number | null; country?: { legacyId: number | null } | null } | null;
}

export function serializeCity(c: CityWithParents): Record<string, unknown> {
  return {
    id: c.legacyId ?? c.id,
    countryId: c.province?.country?.legacyId ?? null,
    provinceId: c.province?.legacyId ?? null,
    name: c.name,
  };
}

interface DistrictWithParents extends District {
  city?: {
    legacyId: number | null;
    province?: { legacyId: number | null; country?: { legacyId: number | null } | null } | null;
  } | null;
}

export function serializeDistrict(d: DistrictWithParents): Record<string, unknown> {
  return {
    id: d.legacyId ?? d.id,
    countryId: d.city?.province?.country?.legacyId ?? null,
    provinceId: d.city?.province?.legacyId ?? null,
    cityId: d.city?.legacyId ?? null,
    name: d.name,
  };
}
