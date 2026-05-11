import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';
import { MemberLiteDto } from '@/common/openapi/member.dto';

export class NetworkJoinResultDto {
  @ApiProperty({ format: 'uuid', example: 'network-uuid-1234' })
  networkId!: string;

  @ApiPropertyOptional({
    enum: ['APPROVED', 'PENDING'],
    example: 'APPROVED',
    description: 'APPROVED for public networks; PENDING when admin approval is required',
  })
  status?: string;

  @ApiPropertyOptional({ type: 'boolean', example: false })
  alreadyJoined?: boolean;

  @ApiPropertyOptional({ type: 'boolean', example: false })
  alreadyRequested?: boolean;

  @ApiPropertyOptional({ type: 'boolean', example: true })
  joined?: boolean;

  @ApiPropertyOptional({ type: 'boolean', example: false })
  alreadyLeft?: boolean;

  @ApiPropertyOptional({ type: 'boolean', example: false })
  left?: boolean;
}

export class NetworkMemberEntryDto {
  @ApiProperty({ example: 555, description: 'NetworkMember legacyId or uuid' })
  networkMemberId!: number | string;

  @ApiProperty({ format: 'date-time', example: '2024-01-01T00:00:00.000Z' })
  joinedAt!: string;

  @ApiProperty({ type: () => MemberLiteDto })
  member!: MemberLiteDto;
}

export class NetworkMemberPageDto {
  @ApiProperty({ type: 'integer', example: 150 })
  total!: number;

  @ApiProperty({ type: 'integer', example: 20 })
  perPage!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  currentPage!: number;

  @ApiProperty({ type: 'integer', example: 8 })
  lastPage!: number;

  @ApiProperty({ type: 'array', itemType: () => NetworkMemberEntryDto })
  items!: NetworkMemberEntryDto[];
}

export class NetworkTagDto {
  @ApiProperty({ format: 'uuid', example: 'tag-uuid-1' })
  id!: string;

  @ApiProperty({ format: 'uuid', example: 'network-uuid-1234' })
  networkId!: string;

  @ApiProperty({ example: 'announcements' })
  name!: string;
}

export class NetworkTagPageDto {
  @ApiProperty({ type: 'integer', example: 12 })
  total!: number;

  @ApiProperty({ type: 'integer', example: 20 })
  perPage!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  currentPage!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  lastPage!: number;

  @ApiProperty({ type: 'array', itemType: () => NetworkTagDto })
  items!: NetworkTagDto[];
}
