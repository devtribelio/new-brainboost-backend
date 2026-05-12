import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';
import { MemberLiteDto } from '@/common/openapi/member.dto';

class PostContentDataDto {
  @ApiProperty({ example: 'Great insights from today\'s workshop on React patterns.' })
  plain!: string;

  @ApiProperty({ type: 'array', example: [] })
  linkData!: unknown[];

  @ApiProperty({ type: 'array', example: [] })
  attributeData!: unknown[];

  @ApiPropertyOptional({ nullable: true, type: 'integer', example: null })
  excerptIndex?: number | null;

  @ApiPropertyOptional({ nullable: true, example: null })
  excerpt?: string | null;
}

class PostTopicDto {
  @ApiProperty({ example: 5 })
  topicId!: number | string;

  @ApiProperty({ example: 'React' })
  topicName!: string;

  @ApiPropertyOptional({ nullable: true, example: 'PUBLIC' })
  topicType?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://cdn.brainboost.com/topics/react.png',
  })
  topicIcon?: string | null;
}

class PostCreatorDto {
  @ApiProperty({ example: 123 })
  memberId!: number | string;

  @ApiPropertyOptional({ nullable: true, example: 'Jane Doe' })
  name?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://cdn.brainboost.com/avatars/jane.jpg',
  })
  profileImage?: string | null;

  @ApiPropertyOptional({ nullable: true })
  profileCoverImage?: string | null;
}

class PostVideoDto {
  @ApiProperty({ example: 'https://www.youtube.com/embed/abc123' })
  url!: string;

  @ApiProperty({ enum: ['youtube', 'bunnycdn', 'other'], example: 'youtube' })
  platform!: string;
}

/**
 * Wire shape for `serializePost()` per FE PostModel (audit §1.7).
 * Plus backend-native extras retained — FE legacy parser ignores unknown keys.
 */
export class PostDto {
  @ApiProperty({ example: 789 })
  postId!: number | string;

  @ApiProperty({ type: () => PostContentDataDto })
  postContentData!: PostContentDataDto;

  @ApiPropertyOptional({
    nullable: true,
    enum: ['text', 'image', 'video', 'embed'],
    example: 'text',
  })
  postType?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'My First Post' })
  title?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'My First Post' })
  contentTitle?: string | null;

  @ApiProperty({ example: 'Great insights from todays workshop on React patterns.' })
  content!: string;

  @ApiPropertyOptional({ nullable: true, example: 'https://www.youtube.com/embed/abc123' })
  embed?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'https://www.youtube.com/embed/abc123' })
  embedUrl?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    description: 'OG-data shape. Currently always null — no OG parser wired yet.',
    example: null,
  })
  embedData?: unknown;

  @ApiPropertyOptional({ nullable: true, example: 'Great insights from todays workshop...' })
  fullContent?: string | null;

  @ApiPropertyOptional({ nullable: true })
  excerpt?: string | null;

  @ApiProperty({
    type: 'array',
    itemType: 'string',
    example: ['https://cdn.brainboost.com/posts/789/hero.jpg'],
  })
  images!: string[];

  @ApiProperty({
    type: 'array',
    example: [],
    description: 'Currently always empty — Post schema has no attachments column.',
  })
  attachments!: unknown[];

  @ApiProperty({
    type: 'array',
    example: [],
    description: 'Currently always empty — Post schema has no audios column.',
  })
  audios!: unknown[];

  @ApiPropertyOptional({ nullable: true, type: 'integer', example: 123 })
  memberIdPost?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    type: () => PostVideoDto,
    description: 'null when videoUrl absent.',
  })
  video?: PostVideoDto | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Currently always null — Post schema has no thumbnail column.',
  })
  videoThumbnailUrl?: string | null;

  @ApiProperty({ enum: ['like', 'dislike'], example: 'dislike' })
  statusLike!: string;

  @ApiProperty({ type: 'integer', example: 42 })
  countLike!: number;

  @ApiPropertyOptional({
    nullable: true,
    type: 'integer',
    description: 'Currently always null — Post schema has no starred column.',
  })
  starred?: number | null;

  @ApiProperty({ type: 'integer', example: 5 })
  countComment!: number;

  @ApiProperty({ example: '5m' })
  timeAgo!: string;

  @ApiProperty({ example: 'Today' })
  dateAgo!: string;

  @ApiPropertyOptional({ nullable: true, type: () => PostTopicDto })
  topic?: PostTopicDto | null;

  @ApiProperty({ type: 'boolean', example: false })
  canEdit!: boolean;

  @ApiProperty({ type: 'boolean', example: false })
  canDelete!: boolean;

  @ApiProperty({ type: 'integer', enum: [0, 1], example: 0 })
  pinned!: number;

  @ApiProperty({
    type: 'integer',
    example: 0,
    description: 'Currently always 0 — no polling feature yet.',
  })
  havePolling!: number;

  @ApiPropertyOptional({ nullable: true, type: () => PostCreatorDto })
  creator?: PostCreatorDto | null;

  @ApiPropertyOptional({
    nullable: true,
    type: 'boolean',
    description: 'Caller-controlled (set by post.controller per viewer membership).',
  })
  isJoined?: boolean | null;

  @ApiPropertyOptional({ nullable: true, example: 'PUBLISHED' })
  publishStatus?: string | null;

  @ApiProperty({ example: 'https://brainboost.com/post/789' })
  postUrl!: string;

  @ApiProperty({ example: 'https://brainboost.com/post/789' })
  postOriginalUrl!: string;

  // ---- Backend-native extras ----

  @ApiProperty({ format: 'uuid', example: 'post-uuid-1234' })
  id!: string;

  @ApiPropertyOptional({ nullable: true, type: 'integer', example: 123 })
  memberId?: number | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid', example: 'network-uuid-1234' })
  networkId?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 1 })
  topicId?: number | string | null;

  @ApiProperty({ type: 'integer', example: 0 })
  countReplies!: number;

  @ApiProperty({ type: 'integer', example: 1024 })
  viewCount!: number;

  @ApiPropertyOptional({ nullable: true, example: 'https://cdn.brainboost.com/posts/789/clip.mp4' })
  videoUrl?: string | null;

  @ApiProperty({ type: 'boolean', example: false })
  isDeleted!: boolean;

  @ApiProperty({ format: 'date-time', example: '2024-05-10T08:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', example: '2024-05-10T08:00:00.000Z' })
  updatedAt!: string;

  @ApiPropertyOptional({ nullable: true, type: () => MemberLiteDto })
  member?: MemberLiteDto | null;
}

export class PostPageDto {
  @ApiProperty({ type: 'integer', example: 384 })
  total!: number;

  @ApiProperty({ type: 'integer', example: 20 })
  perPage!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  currentPage!: number;

  @ApiProperty({ type: 'integer', example: 20 })
  lastPage!: number;

  @ApiProperty({ type: 'array', itemType: () => PostDto })
  items!: PostDto[];
}

export class PostLikeToggleResultDto {
  @ApiProperty({
    enum: ['like', 'dislike'],
    example: 'like',
    description: 'New like state after toggle',
  })
  status!: 'like' | 'dislike';

  @ApiProperty({
    type: 'integer',
    nullable: true,
    example: null,
    description: 'Always null for post-like (FE LikeModel parity).',
  })
  commentId!: number | null;

  @ApiProperty({ type: 'integer', example: 43 })
  countLike!: number;
}

export class PostDeleteResultDto {
  @ApiProperty({ example: 789 })
  postId!: number | string;

  @ApiProperty({ type: 'boolean', example: true })
  deleted!: boolean;
}
