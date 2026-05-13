import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiProperty } from '@/common/openapi/decorators';
import { COMMERCE_PAYMENT_TYPES } from '../constants';

export class PayDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  transactionId!: string;

  @ApiProperty({ enum: COMMERCE_PAYMENT_TYPES, example: 'va' })
  @IsIn([...COMMERCE_PAYMENT_TYPES])
  paymentType!: (typeof COMMERCE_PAYMENT_TYPES)[number];

  @ApiProperty({ required: false, example: 'BCA' })
  @IsOptional()
  @IsString()
  bank?: string;

  @ApiProperty({ required: false, example: 'OVO' })
  @IsOptional()
  @IsString()
  ewalletType?: string;

  @ApiProperty({ required: false, example: '+628123456789' })
  @IsOptional()
  @IsString()
  ewalletPhone?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  cardTokenId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  authenticationId?: string;
}

export class CancelTransactionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  transactionId!: string;
}

export class ValidateVoucherDto {
  @ApiProperty({ example: 'EARLYBIRD' })
  @IsString()
  code!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  productId!: string;
}
