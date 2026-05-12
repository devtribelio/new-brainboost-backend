import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';

export class NetworkJoinResultDto {
  @ApiProperty({ format: 'uuid', example: 'network-uuid-1234' })
  networkId!: string;

  @ApiPropertyOptional({
    enum: ['APPROVED', 'PENDING'],
    example: 'APPROVED',
    description: 'APPROVED for public networks; PENDING when admin approval is required',
  })
  status?: string;

  @ApiPropertyOptional({ type: 'boolean', example: false })
  alreadyJoined?: boolean;

  @ApiPropertyOptional({ type: 'boolean', example: false })
  alreadyRequested?: boolean;

  @ApiPropertyOptional({ type: 'boolean', example: true })
  joined?: boolean;

  @ApiPropertyOptional({ type: 'boolean', example: false })
  alreadyLeft?: boolean;

  @ApiPropertyOptional({ type: 'boolean', example: false })
  left?: boolean;
}

export class NetworkMemberEntryDto {
  @ApiProperty({ example: 555, description: 'Member legacyId or uuid' })
  memberId!: number | string;

  @ApiPropertyOptional({ nullable: true, example: 'Jane Doe' })
  name?: string | null;

  @ApiPropertyOptional({ nullable: true, type: 'integer', example: 102 })
  provinceId?: number | null;

  @ApiPropertyOptional({ nullable: true, example: 'West Java' })
  provinceName?: string | null;

  @ApiPropertyOptional({ nullable: true, type: 'integer', example: 103 })
  cityId?: number | null;

  @ApiPropertyOptional({ nullable: true, example: 'Bandung' })
  cityName?: string | null;

  @ApiProperty({ format: 'email', example: 'jane.doe@example.com' })
  email!: string;

  @ApiPropertyOptional({ nullable: true, example: '8111111111' })
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true, enum: ['MAN', 'WOMEN'], example: 'WOMEN' })
  gender?: string | null;

  @ApiProperty({ type: 'integer', enum: [0, 1], example: 1 })
  isEmailVerified!: number;

  @ApiProperty({ type: 'integer', enum: [0, 1], example: 0 })
  isPhoneVerified!: number;

  @ApiPropertyOptional({ nullable: true, example: '40142' })
  postalCode?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://cdn.brainboost.com/avatars/jane.jpg',
  })
  imageUrl?: string | null;

  @ApiPropertyOptional({ nullable: true })
  coverUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'React + TypeScript fan.' })
  biography?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    format: 'date',
    example: '1990-05-12',
  })
  birthdate?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Jl. Setiabudi No. 1' })
  address?: string | null;

  @ApiProperty({ format: 'date-time', example: '2024-01-01T00:00:00.000Z' })
  dateRegister!: string;
}

export class NetworkMemberPageDto {
  @ApiProperty({ type: 'integer', example: 150 })
  total!: number;

  @ApiProperty({ type: 'integer', example: 20 })
  perPage!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  currentPage!: number;

  @ApiProperty({ type: 'integer', example: 8 })
  lastPage!: number;

  @ApiProperty({ type: 'array', itemType: () => NetworkMemberEntryDto })
  items!: NetworkMemberEntryDto[];
}

export class NetworkTagDto {
  @ApiProperty({ example: 'announcements' })
  tag!: string;

  @ApiProperty({
    type: 'integer',
    example: 17,
    description: 'Posts referencing `#<tag>` in content (naive match).',
  })
  count!: number;

  @ApiProperty({ format: 'date-time', example: '2024-03-10T00:00:00.000Z' })
  created!: string;
}

export class NetworkTagPageDto {
  @ApiProperty({ type: 'integer', example: 12 })
  total!: number;

  @ApiProperty({ type: 'integer', example: 20 })
  perPage!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  currentPage!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  lastPage!: number;

  @ApiProperty({ type: 'array', itemType: () => NetworkTagDto })
  items!: NetworkTagDto[];
}
