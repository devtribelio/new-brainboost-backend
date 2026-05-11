import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';

export class LoginDto {
  @ApiProperty({
    enum: ['password', 'refresh_token', 'social', 'client_credentials'],
    example: 'password',
    description: 'OAuth2 grant type',
  })
  @IsString()
  @IsIn(['password', 'refresh_token', 'social', 'client_credentials'])
  grant_type!: string;

  @ApiPropertyOptional({ example: 'user@example.com', description: 'email/username/phone for password grant' })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional({ example: 'secret123', description: 'plaintext for password grant' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  password?: string;

  @ApiPropertyOptional({
    example: 'rt_7a3c1a52-9f1b-4f8b-9d2a-1e0a7b1c4d51',
    description: 'required when grant_type=refresh_token',
  })
  @IsOptional()
  @IsString()
  refresh_token?: string;

  @ApiPropertyOptional({ enum: ['google', 'facebook', 'apple'], example: 'google' })
  @IsOptional()
  @IsString()
  provider?: string;

  @ApiPropertyOptional({
    example: 'ya29.a0AfH6SMBxxxxxxxxx',
    description: 'social provider id_token',
  })
  @IsOptional()
  @IsString()
  social_token?: string;

  @ApiPropertyOptional({ example: 'brainboost-mobile' })
  @IsOptional()
  @IsString()
  client_id?: string;

  @ApiPropertyOptional({ example: 's3cret-shared-with-server' })
  @IsOptional()
  @IsString()
  client_secret?: string;
}
