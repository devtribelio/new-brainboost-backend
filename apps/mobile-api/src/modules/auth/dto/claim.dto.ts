import { IsString, Length } from 'class-validator';
import { ApiProperty } from '@bb/common/openapi/decorators';

// Account-claim flow: an auto-provisioned buyer sets a real password using the
// opaque claim token from their post-payment email. The token carries the
// memberId, so no email/phone is submitted here.

export class ClaimVerifyDto {
  @ApiProperty({
    description: 'Opaque claim token from the `/claim?token=…` link in the receipt email',
    example: 'bWVtYmVySWQ.MTcwMDAwMDAwMA.c2lnbmF0dXJl',
  })
  @IsString()
  token!: string;
}

export class ClaimDto {
  @ApiProperty({
    description: 'Opaque claim token from the `/claim?token=…` link in the receipt email',
    example: 'bWVtYmVySWQ.MTcwMDAwMDAwMA.c2lnbmF0dXJl',
  })
  @IsString()
  token!: string;

  @ApiProperty({ format: 'password', example: 'N3wP4ssw0rd!', description: 'min 8 chars' })
  @IsString()
  @Length(8, 100)
  newPassword!: string;
}
