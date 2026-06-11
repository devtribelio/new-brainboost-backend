import { IsString } from 'class-validator';
import { ApiProperty } from '@bb/common/openapi/decorators';

export class RequestVerificationEmailDto {
  @ApiProperty({
    example: '42',
    description: 'Member id (legacyId int as string OR UUID).',
  })
  @IsString()
  memberId!: string;
}

export class EmailVerificationResponseDto {
  @ApiProperty({
    example: 42,
    description: 'Member legacyId int, or UUID string when no legacyId set',
  })
  member_id!: number | string;

  @ApiProperty({ example: 'jane@example.com' })
  email!: string;

  @ApiProperty({
    format: 'date-time',
    example: '2026-05-12T10:10:00.000Z',
    description: 'OTP expiry (ISO 8601)',
  })
  expired_date!: string;
}
