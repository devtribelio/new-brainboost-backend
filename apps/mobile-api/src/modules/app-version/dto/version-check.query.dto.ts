import { IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

export const APP_PLATFORMS = ['android', 'ios'] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];

export class VersionCheckQueryDto {
  @ApiProperty({
    example: 'android',
    enum: APP_PLATFORMS as unknown as string[],
    description: 'Client platform. Selects the config row.',
  })
  @IsIn(APP_PLATFORMS as unknown as string[])
  platform!: AppPlatform;

  @ApiProperty({
    example: '3.2.3',
    description:
      'Installed bundle version (semver). The verdict is computed from this field. An unparseable value yields `none` rather than an error.',
  })
  @IsString()
  @MaxLength(32)
  version!: string;

  @ApiPropertyOptional({
    type: 'integer',
    example: 186,
    description:
      'versionCode / iOS build number. Telemetry only — logged, never used for the verdict. Optional so a client that omits it still gets an answer instead of a 400.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  build?: number;
}
