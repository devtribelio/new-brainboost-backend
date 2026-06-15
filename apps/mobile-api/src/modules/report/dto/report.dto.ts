import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

export class ReportCategoryDto {
  @ApiProperty({ format: 'uuid', example: 'report-category-uuid-1' })
  id!: string;

  @ApiProperty({ example: 'Spam' })
  category!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: null,
    description: 'Currently always null — no description column on report_categories yet.',
  })
  description!: string | null;
}

/** Request body for `POST /report/memberReport`. */
export class ReportMemberRequestDto {
  @ApiProperty({
    format: 'uuid',
    example: 'reported-member-uuid',
    description: 'Target member id. Aliases: `targetId`, `targetMemberId`.',
  })
  memberId!: string;

  @ApiProperty({
    format: 'uuid',
    example: 'report-category-uuid-1',
    description: 'Report category id. Alias: `reportCategoryId`.',
  })
  categoryId!: string;

  @ApiPropertyOptional({ nullable: true, format: 'uuid', example: 'network-uuid-1234' })
  networkId?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Spamming the group' })
  reason?: string | null;
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
