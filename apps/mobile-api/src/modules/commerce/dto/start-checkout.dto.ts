import { IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiProperty } from '@bb/common/openapi/decorators';

export class StartCheckoutDto {
  @ApiProperty({ format: 'uuid', example: '0190-...-uuid' })
  @IsUUID()
  productId!: string;

  @ApiProperty({ required: false, example: 'EARLYBIRD' })
  @IsOptional()
  @IsString()
  voucherCode?: string;

  @ApiProperty({
    required: false,
    example: 'P6W0W0',
    description: 'Affiliate code of the link used for this purchase (per-purchase commission override).',
  })
  @IsOptional()
  @IsString()
  affiliatorCode?: string;
}
