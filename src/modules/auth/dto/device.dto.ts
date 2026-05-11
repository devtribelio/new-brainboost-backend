import { IsIn, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';

export class RegisterDeviceDto {
  @ApiProperty({
    example: 'A1B2C3D4-1234-5678-9ABC-DEF012345678',
    description: 'Stable device identifier',
  })
  @IsString()
  deviceId!: string;

  @ApiProperty({ enum: ['ios', 'android', 'web'], example: 'android' })
  @IsString()
  @IsIn(['ios', 'android', 'web'])
  platform!: string;

  @ApiPropertyOptional({
    example: 'fcm:eMxXxxxxxxxxxxxxxxxxxxx:APA91bExampleFCMToken',
    description: 'Firebase Cloud Messaging token',
  })
  @IsOptional()
  @IsString()
  fcmToken?: string;
}

export class CloudMessagingDto {
  @ApiProperty({ example: 'A1B2C3D4-1234-5678-9ABC-DEF012345678' })
  @IsString()
  deviceId!: string;

  @ApiProperty({ example: 'fcm:eMxXxxxxxxxxxxxxxxxxxxx:APA91bExampleFCMToken' })
  @IsString()
  fcmToken!: string;
}
