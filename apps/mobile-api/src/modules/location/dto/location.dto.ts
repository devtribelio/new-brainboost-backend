import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

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
