import type { Request, Response } from 'express';
import { LocationService } from './location.service';
import { ok } from '@/common/utils/response.util';
import { buildPageMeta, parsePagination } from '@/common/utils/pagination.util';
import {
  serializeCountry,
  serializeProvince,
  serializeCity,
  serializeDistrict,
} from '@/common/serializers';

function intOrUndef(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : undefined;
}

export class LocationController {
  constructor(private readonly locationService: LocationService) {}

  listCountries = async (req: Request, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>);
    const keyword = (req.query.keyword as string) ?? undefined;
    const { rows, total } = await this.locationService.listCountries(p, { keyword });
    return ok(res, rows.map(serializeCountry), buildPageMeta(total, p));
  };

  listProvinces = async (req: Request, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>);
    const keyword = (req.query.keyword as string) ?? undefined;
    const countryLegacyId = intOrUndef(req.query.countryId);
    const { rows, total } = await this.locationService.listProvinces(p, {
      keyword,
      countryLegacyId,
    });
    return ok(res, rows.map(serializeProvince), buildPageMeta(total, p));
  };

  listCities = async (req: Request, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>);
    const keyword = (req.query.keyword as string) ?? undefined;
    const provinceLegacyId = intOrUndef(req.query.provinceId);
    const { rows, total } = await this.locationService.listCities(p, {
      keyword,
      provinceLegacyId,
    });
    return ok(res, rows.map(serializeCity), buildPageMeta(total, p));
  };

  listDistricts = async (req: Request, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>);
    const keyword = (req.query.keyword as string) ?? undefined;
    const cityLegacyId = intOrUndef(req.query.cityId);
    const { rows, total } = await this.locationService.listDistricts(p, {
      keyword,
      cityLegacyId,
    });
    return ok(res, rows.map(serializeDistrict), buildPageMeta(total, p));
  };
}
