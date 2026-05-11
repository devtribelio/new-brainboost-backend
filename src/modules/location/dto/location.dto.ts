import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';

export class CountryDto {
  @ApiProperty({ example: 101 })
  countryId!: number | string;

  @ApiProperty({ format: 'uuid', example: 'country-uuid-1' })
  id!: string;

  @ApiProperty({ example: 'Indonesia' })
  name!: string;

  @ApiPropertyOptional({ nullable: true, example: 'ID', description: 'ISO 3166-1 alpha-2' })
  code?: string | null;
}

export class CountryPageDto {
  @ApiProperty({ type: 'integer', example: 250 })
  total!: number;

  @ApiProperty({ type: 'integer', example: 50 })
  perPage!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  currentPage!: number;

  @ApiProperty({ type: 'integer', example: 5 })
  lastPage!: number;

  @ApiProperty({ type: 'array', itemType: () => CountryDto })
  items!: CountryDto[];
}

export class ProvinceDto {
  @ApiProperty({ example: 102 })
  provinceId!: number | string;

  @ApiProperty({ format: 'uuid', example: 'province-uuid-1' })
  id!: string;

  @ApiProperty({ format: 'uuid', example: 'country-uuid-1' })
  countryId!: string;

  @ApiProperty({ example: 'West Java' })
  name!: string;
}

export class ProvincePageDto {
  @ApiProperty({ type: 'integer', example: 34 })
  total!: number;

  @ApiProperty({ type: 'integer', example: 50 })
  perPage!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  currentPage!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  lastPage!: number;

  @ApiProperty({ type: 'array', itemType: () => ProvinceDto })
  items!: ProvinceDto[];
}

export class CityDto {
  @ApiProperty({ example: 103 })
  cityId!: number | string;

  @ApiProperty({ format: 'uuid', example: 'city-uuid-1' })
  id!: string;

  @ApiProperty({ format: 'uuid', example: 'province-uuid-1' })
  provinceId!: string;

  @ApiProperty({ example: 'Bandung' })
  name!: string;
}

export class CityPageDto {
  @ApiProperty({ type: 'integer', example: 514 })
  total!: number;

  @ApiProperty({ type: 'integer', example: 50 })
  perPage!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  currentPage!: number;

  @ApiProperty({ type: 'integer', example: 11 })
  lastPage!: number;

  @ApiProperty({ type: 'array', itemType: () => CityDto })
  items!: CityDto[];
}

export class DistrictDto {
  @ApiProperty({ example: 104 })
  districtId!: number | string;

  @ApiProperty({ format: 'uuid', example: 'district-uuid-1' })
  id!: string;

  @ApiProperty({ format: 'uuid', example: 'city-uuid-1' })
  cityId!: string;

  @ApiProperty({ example: 'Coblong' })
  name!: string;
}

export class DistrictPageDto {
  @ApiProperty({ type: 'integer', example: 7128 })
  total!: number;

  @ApiProperty({ type: 'integer', example: 50 })
  perPage!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  currentPage!: number;

  @ApiProperty({ type: 'integer', example: 143 })
  lastPage!: number;

  @ApiProperty({ type: 'array', itemType: () => DistrictDto })
  items!: DistrictDto[];
}
