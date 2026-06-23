import { IsIn, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

/** Allowed Bunny Stream rendition heights. */
export const MEDIA_RESOLUTIONS = ['360p', '480p', '720p'] as const;
export type MediaResolution = (typeof MEDIA_RESOLUTIONS)[number];

/**
 * Query parameters for `GET /api/member/media/stream`.
 *
 * `t` is the opaque AES-256-GCM media token (see `media-token.util.ts`) — it
 * carries the Bunny `guid`, course id and preview flag so those never appear
 * in the URL. `res` picks the rendition; it falls back to the configured
 * default when omitted.
 */
export class MediaStreamQueryDto {
  @ApiProperty({
    description: 'Opaque media stream token (AES-256-GCM). Carries the Bunny guid + course id.',
    example: 'q1w2e3r4t5y6u7i8o9p0...',
  })
  @IsString()
  t!: string;

  @ApiPropertyOptional({
    enum: MEDIA_RESOLUTIONS,
    description: 'Rendition to stream. Defaults to MEDIA_DEFAULT_RESOLUTION when omitted.',
    example: '720p',
  })
  @IsOptional()
  @IsIn(MEDIA_RESOLUTIONS)
  res?: MediaResolution;
}
