import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';
import { MemberLiteDto } from '@bb/common/openapi/member.dto';

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
  @ApiProperty({ format: 'uuid', example: 'topic-uuid-1234' })
  topicId!: string;

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
  @ApiProperty({ format: 'uuid', example: 'member-uuid-1234' })
  memberId!: string;

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
  @ApiProperty({ format: 'uuid', example: 'post-uuid-1234' })
  postId!: string;

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

  @ApiPropertyOptional({ nullable: true, format: 'uuid', example: 'member-uuid-1234' })
  memberIdPost?: string | null;

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

  @ApiProperty({ type: 'boolean', example: false, description: 'Whether the viewer has liked this post.' })
  isLiked!: boolean;

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

  @ApiProperty({ type: 'boolean', example: false, description: 'Admin-marked as curated/featured content.' })
  isCurated!: boolean;

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

  @ApiPropertyOptional({ nullable: true, format: 'uuid', example: 'member-uuid-1234' })
  memberId?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid', example: 'network-uuid-1234' })
  networkId?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid', example: 'topic-uuid-1234' })
  topicId?: string | null;

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

export class PostLikeToggleResultDto {
  @ApiProperty({
    type: 'boolean',
    example: true,
    description: 'New like state after toggle. true = liked, false = unliked.',
  })
  isLiked!: boolean;

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

// ---- Request body DTOs (Swagger only — runtime uses raw req.body) ----

export class PostLikeBodyDto {
  @ApiProperty({
    example: '789',
    description: 'Post legacyId (int as string) or UUID v7.',
  })
  postId!: string;
}

export class PostCreateBodyDto {
  @ApiProperty({ example: 'Great insights from today\'s workshop on React patterns.' })
  content!: string;

  @ApiPropertyOptional({ example: 'topic-uuid-1234', description: 'Topic UUID — must belong to networkId when both set.' })
  topicId?: string;

  @ApiPropertyOptional({ example: 'network-uuid-1234', description: 'Target network UUID. Omit for global timeline.' })
  networkId?: string;

  @ApiPropertyOptional({ example: 'My First Post' })
  title?: string;

  @ApiPropertyOptional({ enum: ['status', 'image', 'video', 'embed'], example: 'status' })
  postType?: string;

  @ApiPropertyOptional({
    type: 'array',
    itemType: 'string',
    example: ['https://cdn.brainboost.com/posts/789/hero.jpg'],
    description: 'Alias `imageUrls` also accepted.',
  })
  images?: string[];

  @ApiPropertyOptional({ example: 'https://cdn.brainboost.com/posts/789/clip.mp4' })
  videoUrl?: string;

  @ApiPropertyOptional({ example: 'https://www.youtube.com/watch?v=abc123' })
  embedUrl?: string;
}

export class PostDeleteBodyDto {
  @ApiProperty({ example: '789', description: 'Post legacyId or UUID.' })
  postId!: string;
}

export class PostReportBodyDto {
  @ApiProperty({ example: '789', description: 'Post legacyId or UUID.' })
  postId!: string;

  @ApiProperty({ example: 'category-uuid-1234', description: 'Report category UUID. Alias `reportCategoryId` also accepted.' })
  categoryId!: string;

  @ApiPropertyOptional({ example: 'network-uuid-1234' })
  networkId?: string;

  @ApiPropertyOptional({ example: 'Spam content' })
  reason?: string;
}
