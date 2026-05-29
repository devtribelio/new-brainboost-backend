import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@bb/common/openapi/decorators';

export class LogoutDto {
  @ApiPropertyOptional({
    example: 'rt_7a3c1a52-9f1b-4f8b-9d2a-1e0a7b1c4d51',
    description:
      "Refresh token to revoke (optional — falls back to current bearer's active tokens)",
  })
  @IsOptional()
  @IsString()
  refresh_token?: string;

  @ApiPropertyOptional({
    example: 'fcm-token-value-here',
    description: 'FCM (cloud messaging) token to deregister for this member',
  })
  @IsOptional()
  @IsString()
  cloudMessagingId?: string;
}
