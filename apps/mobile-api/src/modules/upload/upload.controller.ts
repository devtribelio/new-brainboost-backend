import type { Request, Response } from 'express';
import { UploadService } from './upload.service';
import { ok } from '@bb/common/utils/response.util';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@bb/common/openapi/decorators';
import { UploadedFilesWrapperDto } from './dto/upload.dto';

@ApiTags('Upload')
@ApiBearerAuth()
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @ApiOperation({
    summary: 'Upload one or more files to a temporary bucket',
    description: 'Multipart form, field name `image`. Returns transient ids consumed by other endpoints.',
  })
  @ApiResponse({ status: 200, type: () => UploadedFilesWrapperDto })
  temporary = async (req: Request, res: Response) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    const result = this.uploadService.uploadTemporary(files);
    // FE FileUploadModel shape: `{image: List<Image>}` — wrap the array.
    return ok(res, { image: result });
  };
}
