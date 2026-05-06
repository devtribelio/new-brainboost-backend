import { IsIn, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';

export class RegisterDeviceDto {
  @ApiProperty({ description: 'Stable device identifier' })
  @IsString()
  deviceId!: string;

  @ApiProperty({ enum: ['ios', 'android', 'web'] })
  @IsString()
  @IsIn(['ios', 'android', 'web'])
  platform!: string;

  @ApiPropertyOptional({ description: 'Firebase Cloud Messaging token' })
  @IsOptional()
  @IsString()
  fcmToken?: string;
}

export class CloudMessagingDto {
  @ApiProperty()
  @IsString()
  deviceId!: string;

  @ApiProperty()
  @IsString()
  fcmToken!: string;
}
