import { IsString, Length } from 'class-validator';
import { ApiProperty } from '@bb/common/openapi/decorators';

export class AcceptTermsDto {
  @ApiProperty({
    example: '2026-10-01',
    description:
      'The `terms.currentVersion` the member was shown. Must equal the live value, else 400 TERMS_VERSION_STALE.',
  })
  @IsString()
  @Length(1, 64)
  version!: string;
}
