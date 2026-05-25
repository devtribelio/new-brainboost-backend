import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';

export class CommunityEntryDto {
  @ApiProperty({ example: 'timeline', description: 'Network purpose tag (e.g. timeline, education)' })
  page!: string;

  @ApiProperty({
    format: 'uuid',
    example: '7a3c1a52-9f1b-4f8b-9d2a-1e0a7b1c4d51',
    description: 'Network UUID',
  })
  networkId!: string;

  @ApiProperty({ example: 'BB-TIMELINE' })
  networkCode!: string;

  @ApiProperty({ example: 'Brainboost Timeline' })
  name!: string;
}

class CountryRefDto {
  @ApiProperty({ format: 'uuid', example: '8f2d1e4a-3b5c-4d6e-9f1a-2b3c4d5e6f7a' })
  id!: string;

  @ApiProperty({ example: 'Indonesia' })
  name!: string;

  @ApiPropertyOptional({ nullable: true, example: 101 })
  legacyId?: number | null;
}

class ProvinceRefDto {
  @ApiProperty({ format: 'uuid', example: '9a1b2c3d-4e5f-6789-abcd-ef0123456789' })
  id!: string;

  @ApiProperty({ example: 'West Java' })
  name!: string;

  @ApiPropertyOptional({ nullable: true, example: 102 })
  legacyId?: number | null;
}

class CityRefDto {
  @ApiProperty({ format: 'uuid', example: 'aaaa1111-bbbb-2222-cccc-3333dddd4444' })
  id!: string;

  @ApiProperty({ example: 'Bandung' })
  name!: string;

  @ApiPropertyOptional({ nullable: true, example: 103 })
  legacyId?: number | null;
}

class DistrictRefDto {
  @ApiProperty({ format: 'uuid', example: 'bbbb2222-cccc-3333-dddd-4444eeee5555' })
  id!: string;

  @ApiProperty({ example: 'Coblong' })
  name!: string;

  @ApiPropertyOptional({ nullable: true, example: 104 })
  legacyId?: number | null;
}

export class MemberInfoProfileDto {
  @ApiPropertyOptional({ nullable: true, example: 'Jl. Setiabudi No. 1' })
  address?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '40142' })
  postalCode?: string | null;

  @ApiPropertyOptional({ nullable: true, type: () => CountryRefDto })
  country?: CountryRefDto | null;

  @ApiPropertyOptional({ nullable: true, type: () => ProvinceRefDto })
  province?: ProvinceRefDto | null;

  @ApiPropertyOptional({ nullable: true, type: () => CityRefDto })
  city?: CityRefDto | null;

  @ApiPropertyOptional({ nullable: true, type: () => DistrictRefDto })
  district?: DistrictRefDto | null;
}

export class MemberInfoDto {
  @ApiProperty({ example: 'Brainboost' })
  appName!: string;

  @ApiProperty({ example: 'brainboost' })
  appCode!: string;

  @ApiProperty({ example: 'https://brainboost.com/affiliate' })
  affiliatePlatformUrl!: string;

  @ApiProperty({
    type: 'integer',
    enum: [0, 1],
    example: 0,
    description: '0 = normal, 1 = maintenance mode active',
  })
  maintenance!: number;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Scheduled maintenance until 02:00 UTC',
  })
  maintenanceMessage?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    format: 'date-time',
    example: '2026-06-01T02:00:00.000Z',
  })
  maintenanceEndDateTime?: string | null;

  @ApiProperty({
    type: 'array',
    itemType: () => CommunityEntryDto,
    description: 'Network entries available as community pages on mobile',
  })
  community!: CommunityEntryDto[];

  @ApiProperty({ example: 123 })
  memberId!: number | string;

  @ApiProperty({ format: 'uuid', example: '7a3c1a52-9f1b-4f8b-9d2a-1e0a7b1c4d51' })
  id!: string;

  @ApiProperty({ format: 'email', example: 'john.doe@example.com' })
  email!: string;

  @ApiPropertyOptional({ nullable: true, example: 'John Doe' })
  name?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '81234567890' })
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '+62' })
  phoneCode?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'https://cdn.brainboost.com/avatars/john.jpg' })
  imageUrl?: string | null;

  @ApiProperty({ type: 'boolean', example: true })
  isVerified!: boolean;

  @ApiProperty({ format: 'date-time', example: '2024-01-15T10:30:00.000Z' })
  createdAt!: string;

  @ApiPropertyOptional({
    nullable: true,
    type: () => MemberInfoProfileDto,
    description: 'Resolved profile + location refs (null if profile not set)',
  })
  profile?: MemberInfoProfileDto | null;

  @ApiPropertyOptional({
    type: 'object',
    example: { lastLoginAt: '2026-05-11T08:00:00.000Z', deviceCount: 2 },
    description: 'Most recent login bookkeeping (memberLogin row)',
  })
  memberLogin?: unknown;

  @ApiPropertyOptional({
    type: 'object',
    example: { defaultNetworkId: 'net-uuid-1', features: { affiliate: true } },
    description: 'Per-tenant system config blob',
  })
  system?: unknown;
}
