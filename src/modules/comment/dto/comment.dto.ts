import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';
import { MemberLiteDto } from '@/common/openapi/member.dto';

/**
 * Wire shape for `serializeComment()` per FE CommentModel (audit §1.7).
 * Plus backend-native extras (id/parentId/images/isDeleted/createdAt/updatedAt/member)
 * — FE legacy parser tolerates unknown keys.
 */
export class CommentDto {
  @ApiProperty({ example: 555 })
  commentId!: number | string;

  @ApiPropertyOptional({ nullable: true, type: 'integer', example: 540 })
  replyId?: number | string | null;

  @ApiProperty({ example: 12 })
  postId!: number | string;

  @ApiPropertyOptional({ nullable: true, type: 'integer', example: 42 })
  memberId?: number | string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Jane Doe' })
  memberName?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://cdn.brainboost.com/avatars/jane.jpg',
  })
  memberProfileImage?: string | null;

  @ApiPropertyOptional({ nullable: true, example: null })
  embed?: string | null;

  @ApiPropertyOptional({ nullable: true, example: null, description: 'Currently always null — embed not modeled in Comment schema.' })
  embedUrl?: unknown;

  @ApiPropertyOptional({ nullable: true, example: null })
  embedData?: unknown;

  @ApiProperty({ example: 'Great post! Saved for later.' })
  content!: string;

  @ApiProperty({
    example: 'Great post! Saved for later.',
    description: 'Same as `content` — no truncation infrastructure yet.',
  })
  fullContent!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://cdn.brainboost.com/temp/abc.jpg',
    description: 'First entry of `images[]` (FE expects singular dynamic).',
  })
  image?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: null,
    description: 'Currently always null — Comment schema has no audio column.',
  })
  audio?: unknown;

  @ApiProperty({ enum: ['like', 'dislike'], example: 'dislike' })
  statusLike!: string;

  @ApiProperty({ example: '5m', description: 'Relative time string (just now / Xm / Xh / Xd / Xw / Xmo / Xy)' })
  timeAgo!: string;

  @ApiProperty({ example: 'Today', description: 'Today | Yesterday | "DD Mon" | "DD Mon YYYY"' })
  dateAgo!: string;

  @ApiProperty({ type: 'integer', example: 5 })
  countLike!: number;

  @ApiProperty({
    type: 'integer',
    example: 0,
    description: 'round(countLike / 1000). Convenience for FE display.',
  })
  countLikeInKilo!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  replyCount!: number;

  @ApiProperty({
    type: 'array',
    itemType: 'string',
    example: ['john', 'mary'],
    description: 'Usernames mentioned via @handle in content (parsed regex).',
  })
  mentions!: string[];

  // ---- Backend-native extras (FE-tolerant; safe to read for debugging) ----

  @ApiProperty({ format: 'uuid', example: 'comment-uuid-1234' })
  id!: string;

  @ApiPropertyOptional({ nullable: true, format: 'uuid', example: 'comment-uuid-parent' })
  parentId?: string | null;

  @ApiProperty({ type: 'array', itemType: 'string', example: [] })
  images!: string[];

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
  @ApiProperty({
    enum: ['like', 'dislike'],
    example: 'like',
    description: 'New like state after toggle',
  })
  status!: 'like' | 'dislike';

  @ApiProperty({
    type: 'integer',
    nullable: true,
    example: 555,
    description: "Comment's legacyId (int). Null when comment has no legacyId.",
  })
  commentId!: number | null;

  @ApiProperty({ type: 'integer', example: 6 })
  countLike!: number;
}

export class CommentDeleteResultDto {
  @ApiProperty({ example: 555 })
  commentId!: number | string;

  @ApiProperty({ type: 'boolean', example: true })
  deleted!: boolean;
}

// ---- Request body DTOs (Swagger only — runtime uses raw req.body) ----

export class CommentLikeBodyDto {
  @ApiProperty({
    example: '555',
    description: 'Comment legacyId (int as string) or UUID v7.',
  })
  commentId!: string;
}

export class CommentCreateBodyDto {
  @ApiProperty({ example: '789', description: 'Post legacyId or UUID.' })
  postId!: string;

  @ApiProperty({ example: 'Nice take — agreed.' })
  content!: string;

  @ApiPropertyOptional({
    example: '540',
    description:
      'Parent comment legacyId/UUID. When set, the new comment is a reply. Aliases: `parentId`.',
  })
  replyId?: string;

  @ApiPropertyOptional({
    type: 'array',
    itemType: 'string',
    example: ['https://cdn.brainboost.com/comments/555/img.jpg'],
    description: 'Alias `imageUrls` also accepted.',
  })
  images?: string[];
}

export class CommentUpdateBodyDto {
  @ApiProperty({ example: '555', description: 'Comment legacyId or UUID.' })
  commentId!: string;

  @ApiProperty({ example: 'Edited: nice take, agreed.' })
  content!: string;
}

export class CommentDeleteBodyDto {
  @ApiProperty({ example: '555', description: 'Comment legacyId or UUID.' })
  commentId!: string;
}
