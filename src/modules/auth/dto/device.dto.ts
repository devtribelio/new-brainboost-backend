import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
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
  @ApiProperty({
    example: 'fcm:eMxXxxxxxxxxxxxxxxxxxxx:APA91bExampleFCMToken',
    description: 'FCM token value (FE field name — wire-level alias of `fcmToken`).',
  })
  @IsString()
  @IsNotEmpty()
  cloudMessagingId!: string;

  @ApiPropertyOptional({
    example: 'A1B2C3D4-1234-5678-9ABC-DEF012345678',
    description:
      "Explicit device id. Omit to target the member's most-recently-seen device (FE legacy single-device assumption).",
  })
  @IsOptional()
  @IsString()
  deviceId?: string;
}

export class DeviceEnrollmentResultDto {
  @ApiProperty({
    type: 'string',
    nullable: true,
    example: 'fcm:eMxXxxxxxxxxxxxxxxxxxxx:APA91bExampleFCMToken',
    description: 'FCM token currently registered for the device. Null when not yet enrolled.',
  })
  cloudMessagingId!: string | null;

  @ApiProperty({
    format: 'uuid',
    example: 'aaaa1111-bbbb-2222-cccc-3333dddd4444',
    description: 'Backend device row UUID.',
  })
  deviceId!: string;
}
