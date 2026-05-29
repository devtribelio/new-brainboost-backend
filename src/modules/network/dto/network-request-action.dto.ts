import { ApiPropertyOptional } from '@bb/common/openapi/decorators';

// Approve/reject body. Provide either `requestId` directly or `(networkId|code) + memberId`.
export class NetworkRequestActionDto {
  @ApiPropertyOptional({
    description: 'NetworkMemberRequest UUID. Preferred direct lookup.',
    format: 'uuid',
    example: 'request-uuid-1234',
  })
  requestId?: string;

  @ApiPropertyOptional({
    description: 'Network code (alphanumeric). Required if `requestId` not provided.',
    example: 'timeline-main',
  })
  code?: string;

  @ApiPropertyOptional({
    description: 'Network UUID. Alternative to `code`.',
    format: 'uuid',
    example: 'network-uuid-1234',
  })
  networkId?: string;

  @ApiPropertyOptional({
    description: 'Requester member UUID. Required if `requestId` not provided.',
    format: 'uuid',
    example: 'member-uuid-1234',
  })
  memberId?: string;
}
