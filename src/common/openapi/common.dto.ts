import { ApiProperty, ApiPropertyOptional } from './decorators';

/**
 * Standard response shapes returned by `@/common/utils/response.util`.
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

export class ApiErrorResponseDto {
  @ApiProperty({
    type: 'integer',
    example: 400,
    description: 'Error code. `0` on success, HTTP-style status code on failure.',
  })
  errCode!: number;

  @ApiProperty({
    type: 'string',
    nullable: true,
    example: 'Invalid credentials',
    description: 'Human-readable error message. `null` on success.',
  })
  errMessage!: string | null;

  @ApiProperty({
    type: 'object',
    nullable: true,
    example: null,
    description: 'Always `null` on failure responses.',
  })
  data!: null;
}

export class GenericOkDto {
  @ApiProperty({ type: 'boolean', example: true })
  ok!: boolean;
}
