import type { Request, Response } from 'express';
import { LocationService } from './location.service';
import { okPaginated } from '@bb/common/utils/response.util';
import { parsePagination } from '@bb/common/utils/pagination.util';
import {
  serializeCountry,
  serializeProvince,
  serializeCity,
  serializeDistrict,
} from './location.serializer';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@bb/common/openapi/decorators';
import { CityDto, CountryDto, DistrictDto, ProvinceDto } from './dto/location.dto';

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
    description: 'Paginated countries',
    type: () => CountryDto,
    isArray: true,
    envelope: 'paginated',
  })
  listCountries = async (req: Request, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>);
    const keyword = (req.query.keyword as string) ?? undefined;
    const countryId = (req.query.countryId as string) ?? undefined;
    const { rows, total } = await this.locationService.listCountries(p, { keyword, countryId });
    return okPaginated(res, rows.map(serializeCountry), { page: p.page, perPage: p.perPage, total });
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
  @ApiResponse({
    status: 200,
    type: () => ProvinceDto,
    isArray: true,
    envelope: 'paginated',
  })
  listProvinces = async (req: Request, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>);
    const keyword = (req.query.keyword as string) ?? undefined;
    const countryLegacyId = intOrUndef(req.query.countryId);
    const { rows, total } = await this.locationService.listProvinces(p, {
      keyword,
      countryLegacyId,
    });
    return okPaginated(res, rows.map(serializeProvince), { page: p.page, perPage: p.perPage, total });
  };

  @ApiOperation({ summary: 'List cities (optionally filtered by country/province)' })
  @ApiQuery({ name: 'countryId', type: 'integer', required: false, example: 101 })
  @ApiQuery({ name: 'provinceId', type: 'integer', required: false, example: 102 })
  @ApiQuery({ name: 'keyword', type: 'string', required: false, example: 'band' })
  @ApiResponse({
    status: 200,
    type: () => CityDto,
    isArray: true,
    envelope: 'paginated',
  })
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
    return okPaginated(res, rows.map(serializeCity), { page: p.page, perPage: p.perPage, total });
  };

  @ApiOperation({ summary: 'List districts (optionally filtered by country/province/city)' })
  @ApiQuery({ name: 'countryId', type: 'integer', required: false, example: 101 })
  @ApiQuery({ name: 'provinceId', type: 'integer', required: false, example: 102 })
  @ApiQuery({ name: 'cityId', type: 'integer', required: false, example: 103 })
  @ApiQuery({ name: 'keyword', type: 'string', required: false, example: 'coblong' })
  @ApiResponse({
    status: 200,
    type: () => DistrictDto,
    isArray: true,
    envelope: 'paginated',
  })
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
    return okPaginated(res, rows.map(serializeDistrict), { page: p.page, perPage: p.perPage, total });
  };
}
