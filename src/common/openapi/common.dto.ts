import { ApiProperty, ApiPropertyOptional } from './decorators';

/**
 * Standard response shapes returned by `@/common/utils/response.util`.
 * Re-used across controllers as `@ApiResponse({ type: () => ... })`.
 */

export class TokenBundleDto {
  @ApiProperty({ description: 'JWT access token (member)' })
  access_token!: string;

  @ApiProperty()
  refresh_token!: string;

  @ApiProperty({ enum: ['Bearer'] })
  token_type!: string;

  @ApiProperty({ type: 'integer', example: 900, description: 'Seconds until access_token expires (OAuth2 RFC 6749 §5.1)' })
  expires_in!: number;
}

export class ApiErrorBodyDto {
  @ApiProperty({ description: 'Human-readable error message' })
  message!: string;

  @ApiPropertyOptional({ type: 'object', description: 'Validation details (when applicable)' })
  details?: unknown;
}

export class ApiErrorResponseDto {
  @ApiProperty({ example: false })
  success!: boolean;

  @ApiProperty({ type: () => ApiErrorBodyDto })
  error!: ApiErrorBodyDto;
}

export class GenericOkDto {
  @ApiProperty({ example: true })
  ok!: boolean;
}
