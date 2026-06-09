import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@bb/common/openapi/decorators';

/** Body for admin reject (disbursement or KYC). */
export class RejectReasonDto {
  @ApiProperty({ example: 'Nama rekening tidak sesuai dengan data KYC', description: 'Reason shown to the member.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
