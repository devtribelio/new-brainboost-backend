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

  @ApiPropertyOptional({ description: 'required when grant_type=refresh_token' })
  @IsOptional()
  @IsString()
  refresh_token?: string;

  @ApiPropertyOptional({ enum: ['google', 'facebook', 'apple'] })
  @IsOptional()
  @IsString()
  provider?: string;

  @ApiPropertyOptional({ description: 'social provider id_token' })
  @IsOptional()
  @IsString()
  social_token?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  client_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  client_secret?: string;
}
