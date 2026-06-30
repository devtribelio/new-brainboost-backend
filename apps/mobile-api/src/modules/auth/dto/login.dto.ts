import { IsIn, IsNotEmpty, IsOptional, IsString, MinLength, ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

export class LoginDto {
  @ApiProperty({
    enum: ['password', 'refresh_token', 'social', 'client_credentials'],
    example: 'password',
    description: 'OAuth2 grant type',
  })
  @IsString()
  @IsIn(['password', 'refresh_token', 'social', 'client_credentials'])
  grant_type!: string;

  @ApiPropertyOptional({
    example: 'user@example.com',
    description: 'email/username/phone for password grant',
  })
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
  @ValidateIf((o: LoginDto) => o.grant_type === 'social')
  @IsString()
  @IsNotEmpty()
  @IsIn(['google', 'facebook', 'apple'])
  provider?: string;

  @ApiPropertyOptional({
    example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6...',
    description: 'social provider id_token (Google id_token for provider=google)',
  })
  @ValidateIf((o: LoginDto) => o.grant_type === 'social')
  @IsString()
  @IsNotEmpty()
  social_token?: string;

  @ApiPropertyOptional({
    example: 'John Doe',
    description:
      "Display name from the social provider. Required for Apple on first sign-in: Apple's identity token never carries the name and only delivers it once (in the native authorization response), so the client must forward it here. Used ONLY on first-time signup (new account); ignored when the account already exists.",
  })
  @IsOptional()
  @IsString()
  social_name?: string;

  @ApiPropertyOptional({
    example: 'JD000001-42',
    description:
      'Affiliate code. Honored ONLY for grant_type=social (provider=google or apple), and ONLY on first-time signup (new account) — binds the inviter. First 8 chars = inviter member code (network suffix ignored). Silently ignored when the account already exists.',
  })
  @IsOptional()
  @IsString()
  affiliateCode?: string;

  @ApiPropertyOptional({ example: 'brainboost-mobile' })
  @IsOptional()
  @IsString()
  client_id?: string;

  @ApiPropertyOptional({ example: 's3cret-shared-with-server' })
  @IsOptional()
  @IsString()
  client_secret?: string;

  @ApiPropertyOptional({
    enum: ['mobile', 'web'],
    example: 'mobile',
    description:
      'Session bucket. Mobile logins kick prior mobile sessions; web logins are multi-session and never kick mobile. Defaults to "mobile" when absent for backward compat with deployed apps.',
  })
  @IsOptional()
  @IsString()
  @IsIn(['mobile', 'web'])
  client_type?: 'mobile' | 'web';
}
