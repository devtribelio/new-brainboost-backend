import { IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

/**
 * Body of `POST /shop/visits`. Documented for OpenAPI only — the route does NOT
 * mount `validateDto`, because a 400 on a marketing link loses the click. Bad
 * input is answered 200 with `status: "invalid"` instead.
 */
export class LogShopVisitDto {
  @ApiProperty({ example: '0190a4d1-8d3b-7c2f-9a11-2f5c1e7d9a01', description: 'Guest id — the `bb_gid` cookie' })
  @IsString()
  guestId!: string;

  @ApiPropertyOptional({ example: 'BB-XYZ', description: 'Product the link pointed at — legacyId | code | slug' })
  @IsOptional()
  @IsString()
  productCode?: string;

  @ApiPropertyOptional({ example: 'webinar' })
  @IsOptional()
  @IsString()
  utmSource?: string;

  @ApiPropertyOptional({ example: 'email' })
  @IsOptional()
  @IsString()
  utmMedium?: string;

  @ApiPropertyOptional({ example: 'sep26' })
  @IsOptional()
  @IsString()
  utmCampaign?: string;

  @ApiPropertyOptional({ example: 'banner-a' })
  @IsOptional()
  @IsString()
  utmContent?: string;

  @ApiPropertyOptional({ example: 'kelas-online' })
  @IsOptional()
  @IsString()
  utmTerm?: string;

  @ApiPropertyOptional({ example: 'https://t.co/abc' })
  @IsOptional()
  @IsString()
  referer?: string;

  @ApiPropertyOptional({
    example: '0190a4d2-1f77-7a3e-bb90-7c1d2e3f4a5b',
    description:
      'Client-generated id, reused across retries of the SAME send. Dedupes retries, not visits — a refresh must send a new id.',
  })
  @IsOptional()
  @IsString()
  clientEventId?: string;
}

/** Body of `POST /shop/visits/claim`. */
export class ClaimShopVisitDto {
  @ApiProperty({ example: '0190a4d1-8d3b-7c2f-9a11-2f5c1e7d9a01', description: 'Guest id — the `bb_gid` cookie' })
  @IsString()
  guestId!: string;
}

export class ShopVisitResultDto {
  @ApiProperty({ enum: ['logged', 'duplicate', 'invalid', 'error'], example: 'logged' })
  status!: string;
}

export class ShopVisitClaimResultDto {
  @ApiProperty({ example: 3, description: 'Visits just bound to this member. 0 is normal.' })
  claimed!: number;
}
