import { IsArray, IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@bb/common/openapi/decorators';

export const OWNERSHIP_VALUES = ['purchased', 'not_purchased'] as const;
export type Ownership = (typeof OWNERSHIP_VALUES)[number];

export const PRODUCT_TYPE_VALUES = ['course', 'mini_course'] as const;
export type ProductType = (typeof PRODUCT_TYPE_VALUES)[number];

export const SORT_VALUES = ['price_asc', 'price_desc', 'newest', 'top_rated'] as const;
export type ProductSort = (typeof SORT_VALUES)[number];

export const MEDIA_VALUES = ['audio', 'video'] as const;
export type ProductMedia = (typeof MEDIA_VALUES)[number];

// Normalise a query param that may arrive as a single string, a CSV string
// (`media=audio,video`), or a repeated param (`media=audio&media=video`) into a
// deduped string[]. `undefined`/empty stays undefined so the filter is skipped.
function toStringArray(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  const flat = raw
    .flatMap((v) => (typeof v === 'string' ? v.split(',') : [v]))
    .map((v) => (typeof v === 'string' ? v.trim() : v))
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  return flat.length > 0 ? Array.from(new Set(flat)) : undefined;
}

export class ListProductsQueryDto {
  @ApiPropertyOptional({ type: 'integer', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ type: 'integer', example: 24 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  perPage?: number;

  @ApiPropertyOptional({ example: 'react' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  keyword?: string;

  @ApiPropertyOptional({
    example: 'course',
    enum: PRODUCT_TYPE_VALUES as unknown as string[],
    description: 'Filter by product type.',
  })
  @IsOptional()
  @IsIn(PRODUCT_TYPE_VALUES as unknown as string[])
  type?: ProductType;

  @ApiPropertyOptional({
    example: 'newest',
    enum: SORT_VALUES as unknown as string[],
    description:
      'Result ordering. `price_asc`/`price_desc` by price, `newest` by creation date (default), `top_rated` by average review stars. Ignored when `ownership=purchased` (kept on purchase date).',
  })
  @IsOptional()
  @IsIn(SORT_VALUES as unknown as string[])
  sort?: ProductSort;

  @ApiPropertyOptional({
    type: 'array',
    itemType: 'string',
    example: ['audio', 'video'],
    enum: MEDIA_VALUES as unknown as string[],
    description:
      'Filter by media kind contained in the course. Repeatable (`media=audio&media=video`) or CSV. Multiple values match products containing ANY of the selected media (OR).',
  })
  @IsOptional()
  @Transform(({ value }) => toStringArray(value))
  @IsArray()
  @IsIn(MEDIA_VALUES as unknown as string[], { each: true })
  media?: ProductMedia[];

  @ApiPropertyOptional({
    example: 'purchased',
    enum: OWNERSHIP_VALUES as unknown as string[],
    description:
      'Restrict by ownership. `purchased` returns only items the authenticated member owns (sorted by purchase date desc). `not_purchased` excludes owned items. Ignored for guests.',
  })
  @IsOptional()
  @IsIn(OWNERSHIP_VALUES as unknown as string[])
  ownership?: Ownership;
}
