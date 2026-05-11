import type { Request, Response } from 'express';
import { LocationService } from './location.service';
import { ok } from '@/common/utils/response.util';
import { buildLegacyPage, parsePagination } from '@/common/utils/pagination.util';
import {
  serializeCountry,
  serializeProvince,
  serializeCity,
  serializeDistrict,
} from '@/common/serializers';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@/common/openapi/decorators';
import {
  CityPageDto,
  CountryPageDto,
  DistrictPageDto,
  ProvincePageDto,
} from './dto/location.dto';

function intOrUndef(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : undefined;
}

@ApiTags('Location')
export class LocationController {
  constructor(private readonly locationService: LocationService) {}

  @ApiOperation({ summary: 'List countries' })
  @ApiQuery({ name: 'page', type: 'integer', required: false, example: 1 })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false, example: 50 })
  @ApiQuery({ name: 'keyword', type: 'string', required: false, example: 'indo' })
  @ApiResponse({
    status: 200,
    description: 'Paginated countries',
    type: () => CountryPageDto,
  })
  listCountries = async (req: Request, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>);
    const keyword = (req.query.keyword as string) ?? undefined;
    const countryId = (req.query.countryId as string) ?? undefined;
    const { rows, total } = await this.locationService.listCountries(p, { keyword, countryId });
    return ok(res, buildLegacyPage(rows.map(serializeCountry), total, p));
  };

  @ApiOperation({ summary: 'List provinces (optionally filtered by country)' })
  @ApiQuery({ name: 'page', type: 'integer', required: false, example: 1 })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false, example: 50 })
  @ApiQuery({ name: 'keyword', type: 'string', required: false, example: 'java' })
  @ApiQuery({
    name: 'countryId',
    type: 'integer',
    required: false,
    example: 101,
    description: 'legacyId or uuid',
  })
  @ApiResponse({ status: 200, type: () => ProvincePageDto })
  listProvinces = async (req: Request, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>);
    const keyword = (req.query.keyword as string) ?? undefined;
    const countryLegacyId = intOrUndef(req.query.countryId);
    const { rows, total } = await this.locationService.listProvinces(p, {
      keyword,
      countryLegacyId,
    });
    return ok(res, buildLegacyPage(rows.map(serializeProvince), total, p));
  };

  @ApiOperation({ summary: 'List cities (optionally filtered by province)' })
  @ApiQuery({ name: 'provinceId', type: 'integer', required: false, example: 102 })
  @ApiQuery({ name: 'keyword', type: 'string', required: false, example: 'band' })
  @ApiResponse({ status: 200, type: () => CityPageDto })
  listCities = async (req: Request, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>);
    const keyword = (req.query.keyword as string) ?? undefined;
    const provinceLegacyId = intOrUndef(req.query.provinceId);
    const { rows, total } = await this.locationService.listCities(p, {
      keyword,
      provinceLegacyId,
    });
    return ok(res, buildLegacyPage(rows.map(serializeCity), total, p));
  };

  @ApiOperation({ summary: 'List districts (optionally filtered by city)' })
  @ApiQuery({ name: 'cityId', type: 'integer', required: false, example: 103 })
  @ApiQuery({ name: 'keyword', type: 'string', required: false, example: 'coblong' })
  @ApiResponse({ status: 200, type: () => DistrictPageDto })
  listDistricts = async (req: Request, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>);
    const keyword = (req.query.keyword as string) ?? undefined;
    const cityLegacyId = intOrUndef(req.query.cityId);
    const { rows, total } = await this.locationService.listDistricts(p, {
      keyword,
      cityLegacyId,
    });
    return ok(res, buildLegacyPage(rows.map(serializeDistrict), total, p));
  };
}
