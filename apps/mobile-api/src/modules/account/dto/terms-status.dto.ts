import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

/**
 * Wire shape of the `terms` block. Returned by POST /member/account/acceptTerms and
 * embedded (additive) in the profile payload, built by ONE helper so they never differ.
 */
export class TermsStatusDto {
  @ApiProperty({ example: true, description: 'false = feature off; needsAcceptance is then always false.' })
  enabled!: boolean;

  @ApiProperty({ example: '2026-10-01', description: 'Live document version (free-form label).' })
  currentVersion!: string;

  @ApiProperty({ example: 'https://brainboost.id/terms', description: 'Page to render in a webview.' })
  url!: string;

  @ApiPropertyOptional({ nullable: true, example: null, description: 'Version this member last accepted; null = never.' })
  acceptedVersion?: string | null;

  @ApiPropertyOptional({ nullable: true, example: null })
  acceptedAt?: string | null;

  @ApiProperty({ example: true, description: 'enabled && acceptedVersion !== currentVersion' })
  needsAcceptance!: boolean;
}
