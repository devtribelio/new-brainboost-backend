import { IsNotEmpty, IsString, Length, Matches, MinLength } from 'class-validator';
import { ApiProperty } from '@bb/common/openapi/decorators';

export class RegisterByPhoneDto {
  @ApiProperty({ example: '8111111111', description: 'Phone number without country code' })
  @IsString()
  @Matches(/^[0-9]{6,20}$/, { message: 'phone must be 6-20 digits, no leading +' })
  phone!: string;

  @ApiProperty({ example: '+62', description: 'Country dial code' })
  @IsString()
  @IsNotEmpty()
  phoneCode!: string;

  @ApiProperty({ example: 'Jane Doe', description: '4-100 chars' })
  @IsString()
  @Length(4, 100)
  name!: string;

  @ApiProperty({ format: 'password', example: 'secret123', description: 'min 8 chars' })
  @IsString()
  @MinLength(8)
  password!: string;
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
