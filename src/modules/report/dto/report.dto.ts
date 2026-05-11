import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';

export class ReportCategoryDto {
  @ApiProperty({ example: 1, description: 'Legacy id or backend uuid' })
  reportCategoryId!: number | string;

  @ApiProperty({ format: 'uuid', example: 'report-category-uuid-1' })
  id!: string;

  @ApiProperty({ example: 'Spam' })
  name!: string;

  @ApiProperty({ type: 'boolean', example: true })
  isActive!: boolean;
}

/**
 * Wire shape for `reportMember()` and `reportPost()` results.
 * Both endpoints return slightly different field sets — both keys included.
 */
export class ReportResultDto {
  @ApiPropertyOptional({
    format: 'uuid',
    example: 'member-report-uuid-1',
    description: 'Returned by reportMember()',
  })
  memberReportMemberId?: string;

  @ApiPropertyOptional({
    example: 1,
    description: 'Returned by reportMember() — category legacyId or uuid',
  })
  memberReportMemberCategoryId?: number | string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Spam',
    description: 'Returned by reportMember()',
  })
  memberReportMemberCategory?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    example: 'post-report-uuid-1',
    description: 'Returned by reportPost()',
  })
  postReportId?: string;

  @ApiPropertyOptional({ format: 'uuid', example: 'post-uuid-1234' })
  postId?: string;

  @ApiPropertyOptional({ format: 'uuid', example: 'report-category-uuid-1' })
  categoryId?: string;

  @ApiPropertyOptional({ nullable: true, format: 'uuid', example: 'network-uuid-1234' })
  networkId?: string | null;

  @ApiPropertyOptional({ format: 'uuid', example: 'reporter-member-uuid' })
  memberId?: string;

  @ApiPropertyOptional({ format: 'uuid', example: 'reported-member-uuid' })
  memberToId?: string;

  @ApiProperty({
    enum: ['REPORTED', 'REVIEWING', 'ACCEPTED', 'REJECTED'],
    example: 'REPORTED',
  })
  reportStatus!: string;
}
