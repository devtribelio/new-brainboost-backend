import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@/common/openapi/decorators';

export const OWNERSHIP_VALUES = ['purchased', 'not_purchased'] as const;
export type Ownership = (typeof OWNERSHIP_VALUES)[number];

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

  @ApiPropertyOptional({ example: 'course' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  type?: string;

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
