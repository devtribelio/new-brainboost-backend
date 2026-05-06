import { IsIn, IsOptional, IsString } from 'class-validator';

export class RegisterDeviceDto {
  @IsString()
  deviceId!: string;

  @IsString()
  @IsIn(['ios', 'android', 'web'])
  platform!: string;

  @IsOptional()
  @IsString()
  fcmToken?: string;
}

export class CloudMessagingDto {
  @IsString()
  deviceId!: string;

  @IsString()
  fcmToken!: string;
}
