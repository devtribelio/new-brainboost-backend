import { ApiProperty, ApiPropertyOptional } from './decorators';

/**
 * Standard response shapes returned by `@bb/common/utils/response.util`.
 * Re-used across controllers as `@ApiResponse({ type: () => ... })`.
 */

export class TokenBundleDto {
  @ApiProperty({
    example:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJtZW1iZXItMTIzIiwic2NvcGUiOiJtZW1iZXIifQ.0nAJYx5MzNxNRkH1bGTzPsq2NgxL9X8a',
    description: 'JWT access token (member or anon scope)',
  })
  access_token!: string;

  @ApiPropertyOptional({
    example: 'rt_7a3c1a52-9f1b-4f8b-9d2a-1e0a7b1c4d51',
    description: 'Long-lived refresh token. Omitted for client_credentials grant.',
  })
  refresh_token?: string;

  @ApiProperty({ enum: ['Bearer'], example: 'Bearer' })
  token_type!: string;

  @ApiProperty({
    type: 'integer',
    example: 900,
    description: 'Seconds until access_token expires (OAuth2 RFC 6749 §5.1)',
  })
  expires_in!: number;

  @ApiPropertyOptional({
    enum: ['member', 'anon'],
    example: 'member',
    description:
      'Token scope. `anon` is issued by client_credentials and only accepts pre-login endpoints.',
  })
  scope?: string;
}

export class GenericOkDto {
  @ApiProperty({ type: 'boolean', example: true })
  ok!: boolean;
}

/** Inner `error` block in the standard envelope. */
export class ApiErrorDto {
  @ApiProperty({
    type: 'string',
    example: 'VALIDATION_ERROR',
    description:
      'Machine-readable error code (e.g. BAD_REQUEST, UNAUTHORIZED, NOT_FOUND, VALIDATION_ERROR).',
  })
  code!: string;

  @ApiProperty({
    type: 'string',
    example: 'Validation failed',
    description: 'Human-readable error message.',
  })
  message!: string;

  @ApiPropertyOptional({
    type: 'object',
    description: 'Optional structured error context (validation field list, etc.).',
  })
  details?: unknown;
}

/**
 * Full error envelope returned by `fail()` for any non-2xx response.
 * Use as `@ApiResponse({ status: 4xx, type: () => ErrorEnvelopeDto, envelope: 'none' })`.
 */
export class ErrorEnvelopeDto {
  @ApiProperty({ type: 'boolean', example: false })
  success!: boolean;

  @ApiProperty({ type: 'object', nullable: true, example: null })
  data!: null;

  @ApiProperty({ type: 'object', nullable: true, example: null })
  meta!: null;

  @ApiProperty({ type: () => ApiErrorDto })
  error!: ApiErrorDto;
}

export class PaginationMetaDto {
  @ApiProperty({ type: 'integer', example: 1, description: 'Current page (1-based)' })
  page!: number;

  @ApiProperty({ type: 'integer', example: 20 })
  perPage!: number;

  @ApiProperty({ type: 'integer', example: 137 })
  total!: number;

  @ApiProperty({ type: 'integer', example: 7 })
  totalPages!: number;
}
