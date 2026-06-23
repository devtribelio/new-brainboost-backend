import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

/**
 * Wire shape for `serializeProduct()` — GET /member/product/list.
 *
 * Clean field names aligned with product/course/detail (FE backend-contract
 * audit P2). Legacy `product*`-prefixed keys renamed: productType→type,
 * productTypeLabel→typeLabel, productCode→code, productSlug→slug,
 * productName→name, productPrice→price, productImageUrl→imageUrl,
 * productCategory→category, productShareDetailUrl→shareUrl. `lastUpdated`
 * retained (FE accepts). `networkAccountProductAffiliatorId` retained pending
 * P3 int-id removal — UUID `id` is the canonical product identifier.
 *
 * BREAKING wire change: coordinate FE deploy before flipping (FE follows the
 * live shape and has dropped its `??` fallbacks).
 */
export class ProductDto {
  @ApiProperty({
    format: 'uuid',
    example: '0193f4c8-9abc-7123-89ab-cdef01234567',
    description: 'Canonical UUID of the product. Use this when calling /commerce checkout.',
  })
  id!: string;

  @ApiProperty({
    example: 456,
    description: 'Legacy int id — pending P3 removal. Use `id` (UUID) instead.',
  })
  networkAccountProductAffiliatorId!: number | string;

  @ApiPropertyOptional({ nullable: true, example: 'course' })
  type?: string | null;

  @ApiProperty({ example: 'Course' })
  typeLabel!: string;

  @ApiProperty({ example: 'react-fundamentals' })
  code!: string;

  @ApiProperty({ example: 'react-fundamentals' })
  slug!: string;

  @ApiPropertyOptional({ nullable: true, example: 'React Fundamentals' })
  name?: string | null;

  @ApiProperty({
    type: 'array',
    itemType: 'string',
    example: ['frontend', 'react', 'javascript'],
  })
  category!: string[];

  @ApiPropertyOptional({ nullable: true, type: 'number', example: 299000 })
  price?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://cdn.brainboost.com/products/react-fundamentals.jpg',
  })
  imageUrl?: string | null;

  @ApiProperty({ format: 'date-time', example: '2024-03-10T11:20:00.000Z' })
  lastUpdated!: string;

  @ApiProperty({ example: 'https://brainboost.com/checkout/react-fundamentals' })
  productPaymentUrl!: string;

  @ApiProperty({ example: 'https://brainboost.com/p/react-fundamentals' })
  shareUrl!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: null,
    description: 'FE `commission` (typo preserved per legacy wire).',
  })
  commisionFixAmount?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 55860,
    description: 'Affiliate commission range — min (iOS net basis, after store cut).',
  })
  commissionMin?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 59600,
    description: 'Affiliate commission range — max (web price basis; equals commisionFixAmount).',
  })
  commissionMax?: number | null;

  @ApiProperty({ example: 'https://brainboost.com/p/react-fundamentals' })
  productUrl!: string;

  @ApiProperty({ type: 'boolean', example: false })
  isPurchased!: boolean;

  @ApiProperty({ type: 'number', example: 4.8 })
  productRatingAvg!: number;
}

export class CourseLessonItemDto {
  @ApiProperty({ example: 'Intro to Hooks' })
  lessonName!: string;

  @ApiPropertyOptional({ nullable: true, example: 'useState and useEffect basics' })
  lessonDescription?: string | null;

  @ApiProperty({
    type: 'integer',
    example: 1200,
    description: 'Lesson duration in seconds = SUM of its media slides\' `duration` (see slidesData[].duration).',
  })
  duration!: number;

  @ApiProperty({ type: 'integer', example: 0, description: '0|1 — legacy emit as int' })
  isPreview!: number;

  @ApiProperty({
    type: 'array',
    description:
      'Lean slide objects `{ id, type, data }`. Media slides expose an opaque `data.streamUrl` ' +
      '(audio under `data.audio.streamUrl`) pointing at the media proxy — Bunny `guid`/`videoLibraryId`/' +
      'iframe HTML are scrubbed. Non-media slide types keep their `data`. Empty array when null.',
    example: [
      {
        id: 'ABC123XYZ',
        type: 'AudioTemplate',
        duration: 480,
        data: {
          title: 'Intro',
          description: '<p>Audio narration</p>',
          audio: {
            streamUrl: '/api/member/media/stream?t=<opaque-token>',
            downloadUrl: '/api/member/media/download?t=<opaque-token>',
          },
        },
      },
      {
        id: 'XYZ789ABC',
        type: 'VideoTemplate',
        duration: 720,
        data: {
          title: 'BLoC Deep Dive',
          description: '<p>Step-by-step</p>',
          platform: 'mp4',
          streamUrl: '/api/member/media/stream?t=<opaque-token>',
          downloadUrl: '/api/member/media/download?t=<opaque-token>',
        },
      },
    ],
  })
  slidesData!: unknown[];
}

export class CourseSectionDto {
  @ApiProperty({ example: 'Getting Started' })
  name!: string;

  @ApiProperty({ type: 'array', itemType: () => CourseLessonItemDto })
  courseLessonData!: CourseLessonItemDto[];
}

export class RatingStarBucketDto {
  @ApiProperty({ type: 'integer', example: 4 })
  total!: number;

  @ApiProperty({ type: 'integer', example: 5 })
  star!: number;

  @ApiProperty({ type: 'number', example: 80.0, description: '0..100 (1-decimal float)' })
  percentage!: number;
}

export class RatingSummaryDto {
  @ApiProperty({ type: 'integer', example: 5 })
  totalReview!: number;

  @ApiProperty({ type: 'number', example: 4.8, description: '1-decimal float' })
  avgReviewStart!: number;

  @ApiProperty({
    description: 'Keyed by stars "1".."5"',
    example: {
      '1': { total: 0, star: 1, percentage: 0 },
      '2': { total: 0, star: 2, percentage: 0 },
      '3': { total: 0, star: 3, percentage: 0 },
      '4': { total: 1, star: 4, percentage: 20.0 },
      '5': { total: 4, star: 5, percentage: 80.0 },
    },
  })
  star!: Record<string, RatingStarBucketDto>;
}

/**
 * Legacy 1:1 shape for GET /member/product/course/detail.
 * Mirrors tribelio-platform response. Do NOT add modern fields here — mobile
 * legacy parser tolerates extras but field naming, order, and nested structure
 * must remain stable.
 */
export class CourseDetailDto {
  @ApiProperty({
    format: 'uuid',
    example: '0193f4c8-9abc-7123-89ab-cdef01234567',
    description: 'Canonical UUID of the product. Use this when calling /commerce checkout.',
  })
  id!: string;

  @ApiPropertyOptional({
    nullable: true,
    type: 'integer',
    example: 123,
    description: 'Legacy int id — pending P3 removal. Use `id` (UUID) instead.',
  })
  courseId?: number | null;

  @ApiProperty({ example: 'react-fundamentals' })
  code!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: 'React Fundamentals',
    description: '"Brainboost" label stripped',
  })
  name?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Hands-on course covering hooks, st',
    description: 'Plain-text excerpt (max 50 chars).',
  })
  description?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://cdn.brainboost.com/products/react-fundamentals.jpg',
  })
  imageUrl?: string | null;

  @ApiProperty({ type: 'integer', example: 299000 })
  price!: number;

  @ApiProperty({ example: 'PUBLISH', description: 'PUBLISH|INACTIVE|DRAFT|ARCHIVED (uppercase)' })
  status!: string;

  @ApiProperty({ type: 'boolean', example: false })
  isPurchase!: boolean;

  @ApiProperty({ example: 'https://brainboost.com/checkout/react-fundamentals' })
  productPaymentUrl!: string;

  @ApiProperty({
    example: 'https://brainboost.com/p/react-fundamentals?affCode=ABC',
    description:
      'Appends ?affCode=<member.affiliateCode> when request is authenticated; bare URL otherwise.',
  })
  productShareDetailUrl!: string;

  @ApiProperty({
    type: 'array',
    itemType: 'string',
    example: ['Lifetime access', 'Certificate of completion', 'Project-based'],
  })
  sellingPoint!: string[];

  @ApiProperty({ type: 'array', itemType: () => CourseSectionDto })
  lessonsData!: CourseSectionDto[];

  @ApiProperty({ type: () => RatingSummaryDto })
  ratingSummary!: RatingSummaryDto;
}

export class ProductShareDto {
  @ApiProperty({ example: 'react-fundamentals' })
  code!: string;

  @ApiProperty({ example: 'https://brainboost.com/p/react-fundamentals' })
  shareUrl!: string;
}
