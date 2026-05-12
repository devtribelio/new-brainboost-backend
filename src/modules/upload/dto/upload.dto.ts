import { ApiProperty } from '@/common/openapi/decorators';

export class UploadedFileDto {
  @ApiProperty({ example: 'photo.jpg', description: 'Original filename from the client' })
  filename!: string;

  @ApiProperty({ type: 'integer', example: 245632, description: 'File size in bytes' })
  size!: number;

  @ApiProperty({ example: 'tmp-abc123.jpg', description: 'Server-assigned transient id' })
  fileId!: string;

  @ApiProperty({ type: 'boolean', example: true })
  status!: boolean;

  @ApiProperty({ example: 'OK' })
  message!: string;

  @ApiProperty({ example: '/static/temporary/tmp-abc123.jpg' })
  url!: string;

  @ApiProperty({ example: 'https://api.brainboost.com/static/temporary/tmp-abc123.jpg' })
  fullUrl!: string;

  @ApiProperty({ example: 'image/jpeg' })
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
