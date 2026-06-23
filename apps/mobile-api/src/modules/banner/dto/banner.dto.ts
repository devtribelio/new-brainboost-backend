import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

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

  @ApiProperty({ type: 'boolean', example: false })
  isPopup!: boolean;

  @ApiPropertyOptional({
    nullable: true,
    format: 'date-time',
    example: '2024-06-01T00:00:00.000Z',
    description: 'Display window open; null = no lower bound',
  })
  startedAt?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    format: 'date-time',
    example: '2024-08-31T23:59:59.000Z',
    description: 'Display window close; null = no upper bound',
  })
  endedAt?: string | null;
}
