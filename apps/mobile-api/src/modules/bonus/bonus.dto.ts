import { ApiProperty } from '@bb/common/openapi/decorators';

/**
 * One bonus attachment as embedded in the course detail `bonuses[]` array
 * (spec §9). `fileKey` is deliberately absent — the client never sees the S3
 * key; it mints access via POST /member/course/bonus/:bonusId/access-url.
 */
export class CourseBonusItemDto {
  @ApiProperty({ format: 'uuid' })
  bonusId!: string;

  @ApiProperty({ example: 'Workbook Deep Sleep' })
  title!: string;

  @ApiProperty({ example: 'workbook-deep-sleep.pdf' })
  fileName!: string;

  @ApiProperty({ type: 'integer', example: 23456789, description: 'File size in bytes (FE >20MB progress UI)' })
  sizeBytes!: number;

  @ApiProperty({ example: 'application/pdf' })
  mimeType!: string;

  @ApiProperty({ type: 'boolean', example: true, description: 'false = view-only in-app' })
  downloadable!: boolean;

  @ApiProperty({ format: 'date-time', example: '2026-07-01T10:00:00.000Z' })
  createdAt!: string;
}

/** Response for POST /member/course/bonus/:bonusId/access-url (spec §9). */
export class BonusAccessUrlDto {
  @ApiProperty({ example: 'https://s3.example.com/private/course-bonus/...?X-Amz-Expires=900...', description: 'Short-lived presigned GET URL (private prefix)' })
  url!: string;

  @ApiProperty({ type: 'integer', example: 900, description: 'URL lifetime in seconds' })
  expiresInSec!: number;
}

/** Minimal row shape the serializer reads — `fileKey` intentionally excluded. */
export interface BonusRowForSerialize {
  id: string;
  title: string;
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  downloadable: boolean;
  createdAt: Date;
}

/** Map a CourseBonus row to the client-facing embedded item. */
export function serializeBonusItem(b: BonusRowForSerialize): CourseBonusItemDto {
  return {
    bonusId: b.id,
    title: b.title,
    fileName: b.fileName,
    sizeBytes: b.sizeBytes,
    mimeType: b.mimeType,
    downloadable: b.downloadable,
    createdAt: b.createdAt.toISOString(),
  };
}
