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
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@/common/openapi/decorators';

function intOrUndef(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : undefined;
}

@ApiTags('Location')
export class LocationController {
  constructor(private readonly locationService: LocationService) {}

  @ApiOperation({ summary: 'List countries' })
  @ApiQuery({ name: 'page', type: 'integer', required: false })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false })
  @ApiQuery({ name: 'keyword', type: 'string', required: false })
  @ApiResponse({ status: 200, description: 'Paginated countries' })
  listCountries = async (req: Request, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>);
    const keyword = (req.query.keyword as string) ?? undefined;
    const { rows, total } = await this.locationService.listCountries(p, { keyword });
    return ok(res, rows.map(serializeCountry), buildPageMeta(total, p));
  };

  @ApiOperation({ summary: 'List provinces (optionally filtered by country)' })
  @ApiQuery({ name: 'page', type: 'integer', required: false })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false })
  @ApiQuery({ name: 'keyword', type: 'string', required: false })
  @ApiQuery({ name: 'countryId', type: 'integer', required: false, description: 'legacyId or cuid' })
  @ApiResponse({ status: 200 })
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

  @ApiOperation({ summary: 'List cities (optionally filtered by province)' })
  @ApiQuery({ name: 'provinceId', type: 'integer', required: false })
  @ApiQuery({ name: 'keyword', type: 'string', required: false })
  @ApiResponse({ status: 200 })
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

  @ApiOperation({ summary: 'List districts (optionally filtered by city)' })
  @ApiQuery({ name: 'cityId', type: 'integer', required: false })
  @ApiQuery({ name: 'keyword', type: 'string', required: false })
  @ApiResponse({ status: 200 })
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
