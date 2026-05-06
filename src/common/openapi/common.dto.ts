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

  @ApiProperty({ example: '15m' })
  expires_in!: string;
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
