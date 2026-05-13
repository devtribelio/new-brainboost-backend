import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';
import { LegacyMetaDto } from '@/common/openapi/common.dto';

export class BannerDto {
  @ApiProperty({ example: 10, description: 'Legacy id or backend uuid' })
  bannerId!: number | string;

  @ApiProperty({ format: 'uuid', example: 'banner-uuid-1' })
  id!: string;

  @ApiProperty({ example: 'Summer Sale 2024' })
  title!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://cdn.brainboost.com/banners/summer-sale.jpg',
  })
  imageUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'https://brainboost.com/sale' })
  linkUrl?: string | null;

  @ApiProperty({ type: 'integer', example: 1 })
  position!: number;

  @ApiProperty({ type: 'boolean', example: true })
  isActive!: boolean;
}

/**
 * FE legacy http envelope for GET /data/banner — emitted by `okLegacy`.
 * Shape: `{ meta: { total, page, lastPage }, data: BannerDto[] }`.
 */
export class BannerPageDto {
  @ApiProperty({ type: () => LegacyMetaDto })
  meta!: LegacyMetaDto;

  @ApiProperty({ type: 'array', itemType: () => BannerDto })
  data!: BannerDto[];
}
