import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';

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
