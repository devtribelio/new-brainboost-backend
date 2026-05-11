import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';

/**
 * Wire shape for `serializeProduct()` — legacy-heavy ProductModel fields.
 */
export class ProductDto {
  @ApiProperty({
    example: 456,
    description: 'Legacy primary key — mobile reads this first',
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

  @ApiPropertyOptional({ nullable: true, example: null })
  commisionFixAmount?: number | null;

  @ApiProperty({ example: 'https://brainboost.com/p/react-fundamentals' })
  productUrl!: string;

  @ApiProperty({ type: 'boolean', example: false })
  isPurchased!: boolean;

  @ApiProperty({ type: 'number', example: 4.8 })
  productRatingAvg!: number;

  // Fallback aliases for mobile fallback chain

  @ApiProperty({ example: 456 })
  productId!: number | string;

  @ApiProperty({ format: 'uuid', example: 'aaaa1111-bbbb-2222-cccc-3333dddd4444' })
  id!: string;

  @ApiPropertyOptional({ nullable: true, example: 'course' })
  type?: string | null;

  @ApiProperty({ example: 'Course' })
  typeLabel!: string;

  @ApiProperty({ example: 'react-fundamentals' })
  code!: string;

  @ApiProperty({ example: 'react-fundamentals' })
  slug!: string;

  @ApiPropertyOptional({ nullable: true, example: 'React Fundamentals' })
  title?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Hands-on course covering hooks, state, and testing.',
  })
  description?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://cdn.brainboost.com/products/react-fundamentals.jpg',
  })
  thumbnail?: string | null;

  @ApiPropertyOptional({ nullable: true, type: 'number', example: 299000 })
  price?: number | null;

  @ApiProperty({ format: 'date-time', example: '2024-03-10T11:20:00.000Z' })
  updatedAt!: string;

  @ApiProperty({ type: 'boolean', example: true })
  isActive!: boolean;

  @ApiProperty({ format: 'date-time', example: '2023-06-01T00:00:00.000Z' })
  createdAt!: string;
}

export class ProductPageDto {
  @ApiProperty({ type: 'integer', example: 137 })
  total!: number;

  @ApiProperty({ type: 'integer', example: 20 })
  perPage!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  currentPage!: number;

  @ApiProperty({ type: 'integer', example: 7 })
  lastPage!: number;

  @ApiProperty({ type: 'array', itemType: () => ProductDto })
  items!: ProductDto[];
}

export class CourseLessonItemDto {
  @ApiProperty({ example: 'Intro to Hooks' })
  lessonName!: string;

  @ApiPropertyOptional({ nullable: true, example: 'useState and useEffect basics' })
  lessonDescription?: string | null;

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
  @ApiProperty({ example: 'Getting Started' })
  name!: string;

  @ApiProperty({ type: 'array', itemType: () => CourseLessonItemDto })
  courseLessonData!: CourseLessonItemDto[];
}

export class RatingStarBucketDto {
  @ApiProperty({ type: 'integer', example: 5 })
  star!: number;

  @ApiProperty({ type: 'integer', example: 80, description: '0..100 (rounded)' })
  percentage!: number;
}

export class RatingSummaryDto {
  @ApiProperty({ type: 'number', example: 4.8 })
  avgReviewStart!: number;

  @ApiProperty({
    description: 'Keyed by stars "1".."5"',
    example: {
      '1': { star: 1, percentage: 0 },
      '2': { star: 2, percentage: 0 },
      '3': { star: 3, percentage: 0 },
      '4': { star: 4, percentage: 20 },
      '5': { star: 5, percentage: 80 },
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

  @ApiPropertyOptional({ nullable: true, example: 'React Fundamentals' })
  name?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Hands-on course covering hooks, state, and testing.',
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

  @ApiProperty({ example: 'active', description: 'active|inactive|draft|archived' })
  status!: string;

  @ApiProperty({ type: 'boolean', example: false })
  isPurchase!: boolean;

  @ApiProperty({ example: 'https://brainboost.com/checkout/react-fundamentals' })
  productPaymentUrl!: string;

  @ApiProperty({ example: 'https://brainboost.com/p/react-fundamentals' })
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
  productId!: string;

  @ApiProperty({ example: 'https://share.example.com/course/react-fundamentals' })
  shareUrl!: string;
}
