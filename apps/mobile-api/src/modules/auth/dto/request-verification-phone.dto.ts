import { IsIn, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

export class RequestVerificationPhoneDto {
  @ApiProperty({
    example: '42',
    description: 'Member id (legacyId int as string OR UUID).',
  })
  @IsString()
  memberId!: string;

  @ApiPropertyOptional({
    enum: ['sms', 'whatsapp'],
    example: 'whatsapp',
    description:
      "Delivery channel hint. Backend dispatcher not yet wired — value logged for future SMS/WA provider integration.",
  })
  @IsOptional()
  @IsString()
  @IsIn(['sms', 'whatsapp'])
  channel?: string;
}
