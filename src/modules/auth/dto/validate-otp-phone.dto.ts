import { IsString, Length } from 'class-validator';
import { ApiProperty } from '@/common/openapi/decorators';

export class ValidateOtpPhoneDto {
  @ApiProperty({
    example: '42',
    description: 'Member id (legacyId int as string OR UUID).',
  })
  @IsString()
  memberId!: string;

  @ApiProperty({ example: '123456', description: 'OTP code from SMS/WhatsApp' })
  @IsString()
  @Length(4, 8)
  verifyCode!: string;
}
