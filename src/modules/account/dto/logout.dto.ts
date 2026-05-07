import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@/common/openapi/decorators';

export class LogoutDto {
  @ApiPropertyOptional({ description: 'Refresh token to revoke (optional — falls back to current bearer\'s active tokens)' })
  @IsOptional()
  @IsString()
  refresh_token?: string;

  @ApiPropertyOptional({ description: 'Device id to clear FCM token for' })
  @IsOptional()
  @IsString()
  deviceId?: string;
}
