import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';

/**
 * Wire shape for `AccountService.affiliateConnect()`.
 */
export class AffiliateConnectResultDto {
  @ApiPropertyOptional({
    nullable: true,
    example: null,
    description: 'Legacy connect-record id. Always null in current implementation.',
  })
  memberNetworkConnectId?: number | string | null;

  @ApiProperty({
    format: 'uuid',
    example: '7a3c1a52-9f1b-4f8b-9d2a-1e0a7b1c4d51',
    description: 'Authenticated member id',
  })
  memberId!: string;

  @ApiPropertyOptional({ nullable: true, example: 'JD000001' })
  affiliatorCode?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 99,
    description: 'Inviter legacyId if available, else inviter uuid',
  })
  affiliatorMemberId?: number | string | null;

  @ApiProperty({
    type: 'boolean',
    example: false,
    description: 'True if the member was already bound to this inviter (idempotent re-call)',
  })
  alreadyConnected!: boolean;
}
