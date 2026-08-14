import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';
import { UPDATE_VERDICTS } from '../version.util';

export class VersionCheckDto {
  @ApiProperty({
    example: 'none',
    enum: UPDATE_VERDICTS as unknown as string[],
    description:
      'The verdict. `force` = blocking, non-dismissible dialog; `soft` = dismissible, shown once per cold start; `none` = nothing. Clients treat an unknown value as `none`, so new verdicts can be added without breaking old builds.',
  })
  update!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: '3.3.0',
    description:
      'What the backend considers current for this platform. Informational. Null when no config row exists for the platform.',
  })
  latestVersion?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: null,
    description:
      'Store listing override. Null in v1 — the app uses its native store redirect. Present so it can be filled later without an app release.',
  })
  storeUrl?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: null,
    description:
      'Dialog body copy (Indonesian) for the returned verdict. Null = client uses its own default copy.',
  })
  message?: string | null;
}
