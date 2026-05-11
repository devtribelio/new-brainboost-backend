import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';
import { MemberLiteDto } from '@/common/openapi/member.dto';
import { TopicDto } from '@/modules/topic/dto/topic.dto';

/**
 * Wire shape for `serializePost()`.
 */
export class PostDto {
  @ApiProperty({ example: 789 })
  postId!: number | string;

  @ApiProperty({ format: 'uuid', example: 'post-uuid-1234' })
  id!: string;

  @ApiProperty({ example: 123, description: 'Author legacyId or uuid' })
  memberId!: number | string;

  @ApiPropertyOptional({ nullable: true, format: 'uuid', example: 'network-uuid-1234' })
  networkId?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 1 })
  topicId?: number | string | null;

  @ApiPropertyOptional({ nullable: true, example: 'My First Post' })
  title?: string | null;

  @ApiProperty({ example: 'Great insights from todays workshop on React patterns.' })
  content!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Great insights from todays workshop...' })
  excerpt?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    enum: ['text', 'image', 'video', 'embed'],
    example: 'text',
  })
  postType?: string | null;

  @ApiProperty({
    type: 'array',
    itemType: 'string',
    example: ['https://cdn.brainboost.com/posts/789/hero.jpg'],
  })
  images!: string[];

  @ApiPropertyOptional({ nullable: true, example: 'https://cdn.brainboost.com/posts/789/clip.mp4' })
  videoUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'https://www.youtube.com/embed/abc123' })
  embedUrl?: string | null;

  @ApiProperty({ type: 'integer', example: 42 })
  countLike!: number;

  @ApiProperty({ type: 'integer', example: 5 })
  countComment!: number;

  @ApiProperty({ type: 'integer', example: 0 })
  countReplies!: number;

  @ApiProperty({ type: 'integer', example: 1024 })
  viewCount!: number;

  @ApiProperty({ enum: ['like', 'dislike'], example: 'dislike' })
  statusLike!: string;

  @ApiProperty({ type: 'boolean', example: false })
  isDeleted!: boolean;

  @ApiProperty({ format: 'date-time', example: '2024-05-10T08:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', example: '2024-05-10T08:00:00.000Z' })
  updatedAt!: string;

  @ApiPropertyOptional({ nullable: true, type: () => MemberLiteDto })
  member?: MemberLiteDto | null;

  @ApiPropertyOptional({ nullable: true, type: () => TopicDto })
  topic?: TopicDto | null;
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
  @ApiProperty({ type: 'boolean', example: true, description: 'New like state after toggle' })
  liked!: boolean;

  @ApiProperty({ type: 'integer', example: 43 })
  countLike!: number;
}

export class PostDeleteResultDto {
  @ApiProperty({ example: 789 })
  postId!: number | string;

  @ApiProperty({ type: 'boolean', example: true })
  deleted!: boolean;
}
