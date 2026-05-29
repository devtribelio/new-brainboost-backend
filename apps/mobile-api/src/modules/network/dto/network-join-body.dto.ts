import { ApiPropertyOptional } from '@bb/common/openapi/decorators';

// Mobile sends `code`. Legacy clients also sent `networkCode` / `networkId`.
// Exactly one is required at runtime; all are marked optional in the schema
// because the handler accepts any of them.
export class NetworkJoinBodyDto {
  @ApiPropertyOptional({
    description:
      'Network 8-char alphanumeric code (preferred). Returned in /api/member/info community entries.',
    example: 'timeline-main',
  })
  code?: string;

  @ApiPropertyOptional({
    description: 'Alias of `code` for legacy clients.',
    example: 'timeline-main',
  })
  networkCode?: string;

  @ApiPropertyOptional({
    description: 'Network UUID. Alternative to `code`.',
    format: 'uuid',
    example: 'network-uuid-1234',
  })
  networkId?: string;

  @ApiPropertyOptional({
    enum: ['join', 'leave'],
    example: 'join',
    description: 'Defaults to `join`. Set to `leave` to remove membership.',
  })
  action?: string;
}
