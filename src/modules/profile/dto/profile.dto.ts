import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';

export class AffiliateConnectedDataDto {
  @ApiPropertyOptional({ nullable: true, example: null })
  memberNetworkConnectId?: number | string | null;

  @ApiProperty({ example: 123, description: 'Self memberId (legacyId or uuid)' })
  memberId!: number | string;

  @ApiPropertyOptional({ nullable: true, example: 'JD000001' })
  affiliatorCode?: string | null;

  @ApiProperty({ example: 99, description: 'Inviter legacyId or uuid' })
  affiliatorMemberId!: number | string;
}

/**
 * Wire shape for GET /member/account/profile/info.
 * Mirrors mobile `ProfileModel` — full member fields plus location keys and affiliate metadata.
 */
export class MemberProfileDto {
  @ApiProperty({ example: 123 })
  memberId!: number | string;

  @ApiProperty({ format: 'uuid', example: '7a3c1a52-9f1b-4f8b-9d2a-1e0a7b1c4d51' })
  id!: string;

  @ApiPropertyOptional({ nullable: true, example: 'JD-001' })
  code?: string | null;

  @ApiProperty({ format: 'email', example: 'john.doe@example.com' })
  email!: string;

  @ApiPropertyOptional({ nullable: true, example: 'John Doe' })
  name?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'John' })
  firstName?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Doe' })
  lastName?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://cdn.brainboost.com/avatars/john.jpg',
  })
  imageUrl?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://cdn.brainboost.com/avatars/john.jpg',
  })
  avatarUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '81234567890' })
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '+62' })
  phoneCode?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://cdn.brainboost.com/covers/john.jpg',
  })
  coverUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Software engineer & lifelong learner.' })
  bio?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Software engineer & lifelong learner.',
    description: 'Legacy alias for `bio`',
  })
  biography?: string | null;

  @ApiPropertyOptional({ nullable: true, enum: ['M', 'F'], example: 'M' })
  gender?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date', example: '1990-05-12' })
  birthdate?: string | null;

  @ApiProperty({ type: 'boolean', example: true })
  isActive!: boolean;

  @ApiProperty({ type: 'boolean', example: true })
  isVerified!: boolean;

  @ApiProperty({ type: 'boolean', example: true })
  isEmailVerified!: boolean;

  @ApiProperty({ type: 'boolean', example: false })
  isPhoneVerified!: boolean;

  @ApiProperty({ format: 'date-time', example: '2024-01-15T10:30:00.000Z' })
  dateRegister!: string;

  @ApiProperty({ format: 'date-time', example: '2024-01-15T10:30:00.000Z' })
  createdAt!: string;

  // ProfileModel-compat fields below

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://cdn.brainboost.com/avatars/john.jpg',
    description: 'Legacy alias for avatarUrl/imageUrl',
  })
  image?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '81234567890' })
  phoneNumber?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Jl. Setiabudi No. 1' })
  address?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '40142' })
  postalCode?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '101',
    description: 'Country legacyId as string, falls back to uuid',
  })
  countryId?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Indonesia' })
  countryName?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '102' })
  provinceId?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'West Java' })
  provinceName?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '103' })
  cityId?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Bandung' })
  cityName?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '104' })
  districtId?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Coblong' })
  districtName?: string | null;

  @ApiProperty({ type: 'integer', enum: [0, 1], example: 0 })
  isPreRegister!: number;

  @ApiProperty({ type: 'integer', example: 0 })
  loginCount!: number;

  @ApiProperty({ type: 'integer', enum: [0, 1], example: 0 })
  isDeleted!: number;

  @ApiPropertyOptional({ nullable: true, example: 'JD000001' })
  affiliatorCode?: string | null;

  @ApiProperty({ type: 'boolean', example: false })
  haveAffiliateConnect!: boolean;

  @ApiPropertyOptional({ nullable: true, type: () => AffiliateConnectedDataDto })
  affiliateConnectedData?: AffiliateConnectedDataDto | null;

  @ApiPropertyOptional({
    type: 'object',
    nullable: true,
    example: {
      id: 'profile-uuid',
      address: 'Jl. Setiabudi No. 1',
      postalCode: '40142',
      countryId: 'country-uuid',
      country: { id: 'country-uuid', name: 'Indonesia', legacyId: 101 },
    },
    description: 'Raw nested MemberProfile (legacy extra, ignored by mobile parser)',
  })
  profile?: unknown;
}

/**
 * Wire shape for POST /member/account/profile/location — raw MemberProfile row from Prisma.
 */
export class MemberLocationDto {
  @ApiProperty({ format: 'uuid', example: 'profile-uuid-1234' })
  id!: string;

  @ApiProperty({ format: 'uuid', example: 'member-uuid-1234' })
  memberId!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Jl. Setiabudi No. 1' })
  address?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '40142' })
  postalCode?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid', example: 'country-uuid' })
  countryId?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid', example: 'province-uuid' })
  provinceId?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid', example: 'city-uuid' })
  cityId?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid', example: 'district-uuid' })
  districtId?: string | null;

  @ApiProperty({ format: 'date-time', example: '2024-02-20T08:15:00.000Z' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', example: '2024-02-20T08:15:00.000Z' })
  updatedAt!: string;
}
