import type { Request, Response } from 'express';
import { UploadService } from './upload.service';
import { ok } from '@/common/utils/response.util';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@/common/openapi/decorators';

@ApiTags('Upload')
@ApiBearerAuth()
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @ApiOperation({
    summary: 'Upload one or more files to a temporary bucket',
    description: 'Multipart form, field name `image`. Returns transient ids consumed by other endpoints.',
  })
  @ApiResponse({ status: 200 })
  temporary = async (req: Request, res: Response) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    const result = this.uploadService.uploadTemporary(files);
    return ok(res, result);
  };
}
