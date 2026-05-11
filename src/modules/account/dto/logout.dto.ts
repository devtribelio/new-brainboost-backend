import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@/common/openapi/decorators';

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
    example: 'A1B2C3D4-1234-5678-9ABC-DEF012345678',
    description: 'Device id to clear FCM token for',
  })
  @IsOptional()
  @IsString()
  deviceId?: string;
}
