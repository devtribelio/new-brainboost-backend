import { IsOptional, IsString, Length, Matches, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

export class RegisterByPhoneDto {
  @ApiProperty({ example: '8111111111', description: 'Phone number without country code' })
  @IsString()
  @Matches(/^[0-9]{6,20}$/, { message: 'phone must be 6-20 digits, no leading +' })
  phone!: string;

  @ApiProperty({ example: '+62', description: 'Country dial code' })
  @IsString()
  @Matches(/^\+?[0-9]{1,4}$/, { message: 'phoneCode must be 1-4 digits, optional leading +' })
  phoneCode!: string;

  @ApiProperty({ example: 'Jane Doe', description: '4-100 chars' })
  @IsString()
  @Length(4, 100)
  name!: string;

  @ApiProperty({ format: 'password', example: 'secret123', description: 'min 8 chars' })
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiPropertyOptional({
    example: 'JD000001-42',
    description:
      'Affiliate code from the invite deeplink. First 8 chars = inviter member code; remaining chars = network legacy id (parsed but unused on this path). Binds `inviterId` on register.',
  })
  @IsOptional()
  @IsString()
  affiliateCode?: string;
}

export class PhoneVerificationResponseDto {
  @ApiProperty({
    example: 42,
    description: 'Member legacyId int, or UUID string when no legacyId set',
  })
  member_id!: number | string;

  @ApiProperty({ example: '+628111111111' })
  phone!: string;

  @ApiProperty({
    format: 'date-time',
    example: '2026-05-12T10:10:00.000Z',
    description: 'OTP expiry (ISO 8601)',
  })
  expired_date!: string;
}
