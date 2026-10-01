import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';
import { ProductDto } from '@/modules/product/dto/product.dto';

export class PromoProductDto extends ProductDto {
  @ApiProperty({
    type: 'integer',
    example: 208600,
    description:
      'Price with the promo voucher applied, before tax, on the same basis as `price`. Equals the checkout quote for this product with `voucherCode`, before PPN.',
  })
  promoPrice!: number;
}

export class PromoDto {
  @ApiProperty({ example: 'oktober', description: 'URL name of the promo.' })
  slug!: string;

  @ApiProperty({ example: 'Promo Oktober BrainBoost' })
  title!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Harga khusus sampai 15 Oktober.' })
  subtitle?: string | null;

  @ApiProperty({ example: 'OKTOBER30', description: 'Voucher that produces `promoPrice` at checkout.' })
  voucherCode!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: '2026-10-15T23:59:59+07:00',
    description: 'When the promo stops: the earlier of the promo and voucher end. Null = open-ended.',
  })
  endsAt?: string | null;

  @ApiProperty({ type: () => [PromoProductDto] })
  products!: PromoProductDto[];
}
