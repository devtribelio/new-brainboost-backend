import { IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

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

  // --- Tracking-link source snapshot (shop web) -----------------------------
  // Sent verbatim from the `bb_attr` / `bb_gid` cookies at submit time and
  // FROZEN on the order. Reporting only: none of these ever feed commission —
  // that stays `affiliatorCode` + AffiliateVisit. Send nothing when there is no
  // source; do NOT send the string "direct", or "the FE never sent it" becomes
  // indistinguishable from "genuinely direct".

  @ApiPropertyOptional({ example: '0190a4d1-8d3b-7c2f-9a11-2f5c1e7d9a01', description: 'Guest id — the `bb_gid` cookie' })
  @IsOptional()
  @IsString()
  guestId?: string;

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
}
