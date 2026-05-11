import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';
import { MemberLiteDto } from '@/common/openapi/member.dto';

/**
 * Wire shape for `serializeComment()`.
 */
export class CommentDto {
  @ApiProperty({ example: 555 })
  commentId!: number | string;

  @ApiProperty({ format: 'uuid', example: 'comment-uuid-1234' })
  id!: string;

  @ApiProperty({ format: 'uuid', example: 'post-uuid-1234' })
  postId!: string;

  @ApiProperty({ example: 123 })
  memberId!: number | string;

  @ApiPropertyOptional({ nullable: true, format: 'uuid', example: 'comment-uuid-parent' })
  replyId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    format: 'uuid',
    example: 'comment-uuid-parent',
    description: 'Same value as replyId',
  })
  parentId?: string | null;

  @ApiProperty({ example: 'Great post! Saved for later.' })
  content!: string;

  @ApiProperty({
    type: 'array',
    itemType: 'string',
    example: [],
  })
  images!: string[];

  @ApiProperty({ type: 'integer', example: 5 })
  countLike!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  countReplies!: number;

  @ApiProperty({ enum: ['like', 'dislike'], example: 'dislike' })
  statusLike!: string;

  @ApiProperty({ type: 'boolean', example: false })
  isDeleted!: boolean;

  @ApiProperty({ format: 'date-time', example: '2024-05-10T09:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', example: '2024-05-10T09:00:00.000Z' })
  updatedAt!: string;

  @ApiPropertyOptional({ nullable: true, type: () => MemberLiteDto })
  member?: MemberLiteDto | null;
}

export class CommentPageDto {
  @ApiProperty({ type: 'integer', example: 24 })
  total!: number;

  @ApiProperty({ type: 'integer', example: 20 })
  perPage!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  currentPage!: number;

  @ApiProperty({ type: 'integer', example: 2 })
  lastPage!: number;

  @ApiProperty({ type: 'array', itemType: () => CommentDto })
  items!: CommentDto[];
}

export class CommentLikeToggleResultDto {
  @ApiProperty({ type: 'boolean', example: true })
  liked!: boolean;

  @ApiProperty({ type: 'integer', example: 6 })
  countLike!: number;
}

export class CommentDeleteResultDto {
  @ApiProperty({ example: 555 })
  commentId!: number | string;

  @ApiProperty({ type: 'boolean', example: true })
  deleted!: boolean;
}
