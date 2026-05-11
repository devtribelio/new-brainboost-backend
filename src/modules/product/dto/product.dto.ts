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

export class CourseInfoDto {
  @ApiProperty({ format: 'uuid', example: 'course-uuid-1234' })
  id!: string;

  @ApiProperty({ type: 'integer', example: 540, description: 'Duration in minutes' })
  durationMin!: number;

  @ApiProperty({ enum: ['beginner', 'intermediate', 'advanced'], example: 'beginner' })
  level!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: 'lms://courses/react-fundamentals',
    description: 'Internal content reference (CDN path or LMS handle)',
  })
  contentRef?: string | null;
}

/**
 * Wire shape for GET /member/product/course/detail — Product fields + nested course block.
 * Fields duplicated from ProductDto rather than via `extends` because the homegrown
 * @ApiProperty decorator stores metadata per-class and inheritance would mutate the
 * parent's map.
 */
export class CourseDetailDto {
  @ApiProperty({ example: 456 })
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

  @ApiPropertyOptional({ nullable: true, type: () => CourseInfoDto })
  course?: CourseInfoDto | null;
}

export class ProductShareDto {
  @ApiProperty({ example: 'react-fundamentals' })
  productId!: string;

  @ApiProperty({ example: 'https://share.example.com/course/react-fundamentals' })
  shareUrl!: string;
}
