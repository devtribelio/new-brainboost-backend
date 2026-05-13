import { IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiProperty } from '@/common/openapi/decorators';

export class StartCheckoutDto {
  @ApiProperty({ format: 'uuid', example: '0190-...-uuid' })
  @IsUUID()
  productId!: string;

  @ApiProperty({ required: false, example: 'EARLYBIRD' })
  @IsOptional()
  @IsString()
  voucherCode?: string;
}
