import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';
import { LegacyMetaDto } from '@/common/openapi/common.dto';

/**
 * Wire shape for `serializeProduct()` per FE legacy ProductModel (audit §1.5
 * #55). Canonical names only (audit §3.1) — fallback aliases dropped.
 *
 * FE legacy parser uses `??` chains; backend picks the leftmost-of-fallback:
 * - id ← `networkAccountProductAffiliatorId`
 * - type ← `productType`
 * - typeLabel ← `productTypeLabel`
 * - code ← `productCode`
 * - slug ← `productSlug`
 * - name ← `productName`
 * - price ← `productPrice`
 * - thumbnail ← `productImageUrl`
 * - lastUpdate ← `lastUpdated`
 * - shareUrl ← `productShareDetailUrl`
 * - commission ← `commisionFixAmount` (sic — legacy typo preserved)
 *
 * Once FE confirms it reads only these names, drop the `??` fallbacks
 * client-side.
 */
export class ProductDto {
  @ApiProperty({
    example: 456,
    description: 'FE id (`?? productId`) — canonical key for ProductModel.id',
  })
  networkAccountProductAffiliatorId!: number | string;

  @ApiPropertyOptional({ nullable: true, example: 'course' })
  productType?: string | null;

  @ApiProperty({ example: 'Course' })
  productTypeLabel!: string;

  @ApiProperty({ example: 'react-fundamentals' })
  productCode!: string;

  @ApiProperty({ example: 'react-fundamentals' })
  productSlug!: string;

  @ApiPropertyOptional({ nullable: true, example: 'React Fundamentals' })
  productName?: string | null;

  @ApiProperty({
    type: 'array',
    itemType: 'string',
    example: ['frontend', 'react', 'javascript'],
  })
  productCategory!: string[];

  @ApiPropertyOptional({ nullable: true, type: 'number', example: 299000 })
  productPrice?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://cdn.brainboost.com/products/react-fundamentals.jpg',
  })
  productImageUrl?: string | null;

  @ApiProperty({ format: 'date-time', example: '2024-03-10T11:20:00.000Z' })
  lastUpdated!: string;

  @ApiProperty({ example: 'https://brainboost.com/checkout/react-fundamentals' })
  productPaymentUrl!: string;

  @ApiProperty({ example: 'https://brainboost.com/p/react-fundamentals' })
  productShareDetailUrl!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: null,
    description: 'FE `commission` (typo preserved per legacy wire).',
  })
  commisionFixAmount?: number | null;

  @ApiProperty({ example: 'https://brainboost.com/p/react-fundamentals' })
  productUrl!: string;

  @ApiProperty({ type: 'boolean', example: false })
  isPurchased!: boolean;

  @ApiProperty({ type: 'number', example: 4.8 })
  productRatingAvg!: number;
}

/**
 * FE legacy http envelope for GET /product/list — emitted by `okLegacy`.
 * Shape: `{ meta: { total, page, lastPage }, data: ProductDto[] }`.
 */
export class ProductPageDto {
  @ApiProperty({ type: () => LegacyMetaDto })
  meta!: LegacyMetaDto;

  @ApiProperty({ type: 'array', itemType: () => ProductDto })
  data!: ProductDto[];
}

export class CourseLessonItemDto {
  @ApiProperty({ type: 'integer', example: 5001 })
  courseLessonId!: number;

  @ApiProperty({ type: 'integer', example: 123 })
  courseId!: number;

  @ApiProperty({ example: 'Intro to Hooks' })
  lessonName!: string;

  @ApiPropertyOptional({ nullable: true, example: 'useState and useEffect basics' })
  lessonDescription?: string | null;

  @ApiProperty({ type: 'integer', example: 0 })
  joined!: number;

  @ApiProperty({ type: 'integer', example: 3 })
  slideCount!: number;

  @ApiProperty({ type: 'integer', example: 0 })
  duration!: number;

  @ApiProperty({ example: 'LESSON-001' })
  code!: string;

  @ApiProperty({ type: 'integer', example: 0 })
  orderColumn!: number;

  @ApiProperty({ example: 'Intro to Hooks' })
  title!: string;

  @ApiProperty({ example: 'ACTIVE' })
  lessonStatus!: string;

  @ApiProperty({ example: 'intro-to-hooks' })
  slug!: string;

  @ApiProperty({ type: 'integer', example: 1001 })
  courseSectionId!: number;

  @ApiProperty({ type: 'integer', example: 0, description: '0|1 — legacy emit as int' })
  isPreview!: number;

  @ApiProperty({
    type: 'array',
    description:
      'Slide objects per lesson — shape per type (AudioTemplate/VideoTemplate/GreetingTemplate/ThankYouTemplate/DocumentTemplate). Pass-through from JSONB column. Empty array when null.',
    example: [
      {
        id: 'ABC123XYZ',
        type: 'AudioTemplate',
        name: 'Intro Audio',
        duration: '120',
        data: {
          title: 'Intro',
          description: '<p>Audio narration</p>',
          audio: {
            guid: 'bunny-guid-xxx',
            videoLibraryId: '152957',
            storageSize: 1048576,
            availableResolutions: [],
          },
          platform: 'files',
        },
      },
    ],
  })
  slidesData!: unknown[];
}

export class CourseSectionDto {
  @ApiProperty({ type: 'integer', example: 1001 })
  courseSectionId!: number;

  @ApiProperty({ type: 'integer', example: 123 })
  courseId!: number;

  @ApiProperty({ type: 'integer', example: 0, description: 'Hardcoded 0 (single-tenant)' })
  networkAccountId!: number;

  @ApiProperty({ type: 'integer', example: 0, description: 'Hardcoded 0 (single-tenant)' })
  memberId!: number;

  @ApiProperty({ example: 'Getting Started' })
  name!: string;

  @ApiProperty({ type: 'integer', example: 0 })
  orderColumn!: number;

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
  @ApiPropertyOptional({ nullable: true, type: 'integer', example: 123 })
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
    description: 'Plain-text excerpt (max 50 chars). Use descriptionHtml for full rich text.',
  })
  description?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '<p>Hands-on course covering <strong>hooks</strong>...</p>',
  })
  descriptionHtml?: string | null;

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
