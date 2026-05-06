import type { Response } from 'express';
import { NotificationService } from './notification.service';
import { ok } from '@/common/utils/response.util';
import { UnauthorizedException } from '@/common/exceptions';
import { buildPageMeta, parsePagination } from '@/common/utils/pagination.util';
import { serializeNotification } from '@/common/serializers';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@/common/openapi/decorators';

@ApiTags('Notification')
@ApiBearerAuth()
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @ApiOperation({ summary: 'List my notifications (with unread count)' })
  @ApiQuery({ name: 'page', type: 'integer', required: false })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false })
  @ApiResponse({ status: 200 })
  list = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const p = parsePagination(req.query as Record<string, unknown>);
    const { rows, total, unread } = await this.notificationService.listForMember(p, req.user.id);
    return ok(res, rows.map(serializeNotification), {
      ...buildPageMeta(total, p),
      unread,
    });
  };

  @ApiOperation({ summary: 'Mark notifications as seen (all or by ids)' })
  @ApiResponse({ status: 200 })
  seen = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const ids = Array.isArray(req.body?.notificationIds)
      ? (req.body.notificationIds as string[])
      : undefined;
    const result = await this.notificationService.markSeen(req.user.id, ids);
    return ok(res, { updated: result.count });
  };
}
