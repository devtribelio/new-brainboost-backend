import { ApiProperty, ApiPropertyOptional } from './decorators';

/**
 * Wire shape for `serializeMember()` — lite form embedded in posts/comments/network.
 */
export class MemberLiteDto {
  @ApiProperty({ example: 123, description: 'Legacy integer id when present, falls back to backend uuid' })
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
    description: 'Legacy field name — same value as avatarUrl',
  })
  imageUrl?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://cdn.brainboost.com/avatars/john.jpg',
  })
  avatarUrl?: string | null;
}

/**
 * Wire shape for `serializeMemberFull()` — used by /member/info and /profile/info.
 * Fields are inlined (not via class inheritance) because the homegrown @ApiProperty
 * decorator stores metadata per-class and inheritance would mutate the parent's map.
 */
export class MemberFullDto {
  @ApiProperty({ example: 123, description: 'Legacy integer id when present, falls back to backend uuid' })
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

  @ApiPropertyOptional({ nullable: true, example: 'https://cdn.brainboost.com/avatars/john.jpg' })
  imageUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'https://cdn.brainboost.com/avatars/john.jpg' })
  avatarUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '81234567890' })
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '+62' })
  phoneCode?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'https://cdn.brainboost.com/covers/john.jpg' })
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

  @ApiProperty({ type: 'boolean', example: true, description: 'Legacy alias for `isVerified`' })
  isEmailVerified!: boolean;

  @ApiProperty({ type: 'boolean', example: false })
  isPhoneVerified!: boolean;

  @ApiProperty({
    format: 'date-time',
    example: '2024-01-15T10:30:00.000Z',
    description: 'Legacy alias for `createdAt`',
  })
  dateRegister!: string;

  @ApiProperty({ format: 'date-time', example: '2024-01-15T10:30:00.000Z' })
  createdAt!: string;
}
