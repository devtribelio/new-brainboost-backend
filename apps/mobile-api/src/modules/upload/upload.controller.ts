import type { Request, Response } from 'express';
import { UploadService } from './upload.service';
import { ok } from '@bb/common/utils/response.util';
import type { AuthenticatedRequest } from '@bb/common/interfaces/authenticated-request';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@bb/common/openapi/decorators';
import { UploadedFilesWrapperDto, UploadQueryDto } from './dto/upload.dto';
import { UPLOAD_KIND_VALUES } from './upload.service';

@ApiTags('Upload')
@ApiBearerAuth()
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @ApiOperation({
    summary: 'Upload one or more images to public object storage',
    description:
      'Multipart form, field name `image`. Images are re-encoded to webp and stored under ' +
      '`public/uploads/<userId>/`. Returns object keys + public CDN URLs consumed by other endpoints.',
  })
  @ApiQuery({
    name: 'kind',
    required: false,
    enum: UPLOAD_KIND_VALUES,
    example: 'avatar',
    description: 'Target folder: public/<folder>/<userId>/. Default `general` → public/uploads/.',
  })
  @ApiBody({
    description: 'Multipart form. Field `image` accepts one or more image files.',
    contentType: 'multipart/form-data',
    schema: {
      type: 'object',
      required: ['image'],
      properties: {
        image: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          description: 'One or more image files (jpeg/png/webp/…). Re-encoded to webp server-side.',
        },
      },
    },
  })
  @ApiResponse({ status: 200, type: () => UploadedFilesWrapperDto })
  temporary = async (req: Request, res: Response) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    const ownerId = (req as AuthenticatedRequest).user!.id;
    const { kind } = req.query as UploadQueryDto;
    const result = await this.uploadService.uploadImages(files, ownerId, kind);
    // FE FileUploadModel shape: `{image: List<Image>}` — wrap the array.
    return ok(res, { image: result });
  };
}
