import type { Request, Response } from 'express';
import { PostKindService } from './post-kind.service';
import { ok } from '@bb/common/utils/response.util';
import { ApiOperation, ApiResponse, ApiTags } from '@bb/common/openapi/decorators';
import { PostKindListDto } from './dto/post-kind.dto';

@ApiTags('Community')
export class PostKindController {
  constructor(private readonly postKindService: PostKindService) {}

  @ApiOperation({ summary: 'List selectable post kinds (array order = display order)' })
  @ApiResponse({ status: 200, type: () => PostKindListDto })
  list = async (_req: Request, res: Response) => {
    return ok(res, { items: await this.postKindService.list() });
  };
}
