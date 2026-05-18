import type { Request, Response } from 'express';
import { LocationService } from './location.service';
import { okLegacy } from '@/common/utils/response.util';
import { parsePagination } from '@/common/utils/pagination.util';
import {
  serializeCountry,
  serializeProvince,
  serializeCity,
  serializeDistrict,
} from './location.serializer';
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
  @ApiQuery({ name: 'perPage', type: 'integer', required: false, example: 20 })
  @ApiQuery({ name: 'keyword', type: 'string', required: false, example: 'indo' })
  @ApiResponse({
    status: 200,
    description: 'Paginated countries (FE legacy http envelope)',
    type: () => CountryPageDto,
    envelope: 'none',
  })
  listCountries = async (req: Request, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>);
    const keyword = (req.query.keyword as string) ?? undefined;
    const countryId = (req.query.countryId as string) ?? undefined;
    const { rows, total } = await this.locationService.listCountries(p, { keyword, countryId });
    return okLegacy(res, rows.map(serializeCountry), total, p.page, p.perPage);
  };

  @ApiOperation({ summary: 'List provinces (optionally filtered by country)' })
  @ApiQuery({ name: 'page', type: 'integer', required: false, example: 1 })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false, example: 20 })
  @ApiQuery({ name: 'keyword', type: 'string', required: false, example: 'java' })
  @ApiQuery({
    name: 'countryId',
    type: 'integer',
    required: false,
    example: 101,
    description: 'Parent country legacyId',
  })
  @ApiResponse({ status: 200, type: () => ProvincePageDto, envelope: 'none' })
  listProvinces = async (req: Request, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>);
    const keyword = (req.query.keyword as string) ?? undefined;
    const countryLegacyId = intOrUndef(req.query.countryId);
    const { rows, total } = await this.locationService.listProvinces(p, {
      keyword,
      countryLegacyId,
    });
    return okLegacy(res, rows.map(serializeProvince), total, p.page, p.perPage);
  };

  @ApiOperation({ summary: 'List cities (optionally filtered by country/province)' })
  @ApiQuery({ name: 'countryId', type: 'integer', required: false, example: 101 })
  @ApiQuery({ name: 'provinceId', type: 'integer', required: false, example: 102 })
  @ApiQuery({ name: 'keyword', type: 'string', required: false, example: 'band' })
  @ApiResponse({ status: 200, type: () => CityPageDto, envelope: 'none' })
  listCities = async (req: Request, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>);
    const keyword = (req.query.keyword as string) ?? undefined;
    const countryLegacyId = intOrUndef(req.query.countryId);
    const provinceLegacyId = intOrUndef(req.query.provinceId);
    const { rows, total } = await this.locationService.listCities(p, {
      keyword,
      countryLegacyId,
      provinceLegacyId,
    });
    return okLegacy(res, rows.map(serializeCity), total, p.page, p.perPage);
  };

  @ApiOperation({ summary: 'List districts (optionally filtered by country/province/city)' })
  @ApiQuery({ name: 'countryId', type: 'integer', required: false, example: 101 })
  @ApiQuery({ name: 'provinceId', type: 'integer', required: false, example: 102 })
  @ApiQuery({ name: 'cityId', type: 'integer', required: false, example: 103 })
  @ApiQuery({ name: 'keyword', type: 'string', required: false, example: 'coblong' })
  @ApiResponse({ status: 200, type: () => DistrictPageDto, envelope: 'none' })
  listDistricts = async (req: Request, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>);
    const keyword = (req.query.keyword as string) ?? undefined;
    const countryLegacyId = intOrUndef(req.query.countryId);
    const provinceLegacyId = intOrUndef(req.query.provinceId);
    const cityLegacyId = intOrUndef(req.query.cityId);
    const { rows, total } = await this.locationService.listDistricts(p, {
      keyword,
      countryLegacyId,
      provinceLegacyId,
      cityLegacyId,
    });
    return okLegacy(res, rows.map(serializeDistrict), total, p.page, p.perPage);
  };
}
