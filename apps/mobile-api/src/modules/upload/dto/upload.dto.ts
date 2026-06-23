import { IsIn, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';
import { UPLOAD_KIND_VALUES, type UploadKind } from '../upload.service';

export class UploadQueryDto {
  @ApiPropertyOptional({
    enum: UPLOAD_KIND_VALUES,
    example: 'avatar',
    description:
      'Target folder. Maps to `public/<folder>/<userId>/`. Defaults to `general` (public/uploads/).',
  })
  @IsOptional()
  @IsIn(UPLOAD_KIND_VALUES)
  kind?: UploadKind;
}

export class UploadedFileDto {
  @ApiProperty({ example: 'photo.jpg', description: 'Original filename from the client' })
  filename!: string;

  @ApiProperty({ type: 'integer', example: 245632, description: 'File size in bytes' })
  size!: number;

  @ApiProperty({
    example: 'public/uploads/01935f.../a1b2c3.webp',
    description: 'S3 object key — the durable id other endpoints persist',
  })
  fileId!: string;

  @ApiProperty({ example: 'success' })
  status!: string;

  @ApiProperty({ example: 'OK' })
  message!: string;

  @ApiProperty({
    example: 'public/uploads/01935f.../a1b2c3.webp',
    description: 'Object key (same as fileId)',
  })
  url!: string;

  @ApiProperty({ example: 'https://cdn.brainboost.com/public/uploads/01935f.../a1b2c3.webp' })
  fullUrl!: string;

  @ApiProperty({ example: 'image/webp' })
  type!: string;
}

export class UploadedFilesWrapperDto {
  @ApiProperty({
    type: 'array',
    itemType: () => UploadedFileDto,
    description: 'Uploaded files. Wrapper matches FE FileUploadModel shape (image: List<Image>).',
  })
  image!: UploadedFileDto[];
}
