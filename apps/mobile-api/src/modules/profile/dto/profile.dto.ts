import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

/**
 * Request body for POST /member/account/profile/update.
 * Controller accepts canonical names + legacy aliases (name|fullName,
 * biography|bio, imageUrl|avatarUrl, coverImageUrl|coverUrl). All optional —
 * partial update. Documented here so swagger shows the request shape.
 */
export class UpdateProfileRequestDto {
  @ApiPropertyOptional({ nullable: true, example: 'John Doe', description: 'Full name (alias: fullName).' })
  name?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '81234567890' })
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '+62' })
  phoneCode?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Software engineer & lifelong learner.', description: 'Bio (alias: bio).' })
  biography?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'https://cdn.brainboost.com/avatars/john.jpg', description: 'Avatar URL (alias: avatarUrl).' })
  imageUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'https://cdn.brainboost.com/covers/john.jpg', description: 'Cover URL (alias: coverUrl).' })
  coverImageUrl?: string | null;
}

/**
 * Request body for POST /member/account/profile/location.
 * Location FK chain (string IDs) + address. All optional.
 */
export class UpdateLocationRequestDto {
  @ApiPropertyOptional({ nullable: true, example: '101' })
  countryId?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '102' })
  provinceId?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '103' })
  cityId?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '104' })
  districtId?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Jl. Setiabudi No. 1' })
  address?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '40142' })
  postalCode?: string | null;
}

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
 * Wire shape for GET /member/account/profile/info per FE ProfileModel
 * (audit §1.2 #9 + §2.2 #47). Canonical field names per audit §3.1 — legacy
 * aliases (imageUrl, avatarUrl, biography, isVerified, dateRegister, code,
 * gender, birthdate, coverUrl) DROPPED. FE retires its `??` fallback chains
 * once stable.
 */
export class MemberProfileDto {
  @ApiProperty({ example: 123 })
  memberId!: number | string;

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://cdn.brainboost.com/avatars/john.jpg',
    description: 'Avatar URL (canonical — replaces `imageUrl` / `memberImageUrl`).',
  })
  image?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'John Doe' })
  name?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'john@example.com',
    description: 'Null for phone-registered members that have not set an email.',
  })
  email?: string | null;

  @ApiPropertyOptional({ example: true })
  isEmailVerified?: boolean;

  @ApiPropertyOptional({ example: true })
  isPhoneVerified?: boolean;

  @ApiPropertyOptional({ nullable: true, example: '81234567890' })
  phoneNumber?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '+62' })
  phoneCode?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '40142' })
  postalCode?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '101',
    description: 'Country legacyId as string (per audit §3.2 — prefer string for IDs).',
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

  @ApiPropertyOptional({
    nullable: true,
    example: 'Software engineer & lifelong learner.',
    description: 'Member bio (canonical — replaces `biography`).',
  })
  bio?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Jl. Setiabudi No. 1' })
  address?: string | null;

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
