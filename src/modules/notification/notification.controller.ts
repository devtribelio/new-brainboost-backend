import type { Response } from 'express';
import { NotificationService } from './notification.service';
import { ok } from '@/common/utils/response.util';
import { UnauthorizedException } from '@/common/exceptions';
import { buildLegacyPage, parsePagination } from '@/common/utils/pagination.util';
import { serializeNotification } from './notification.serializer';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@/common/openapi/decorators';
import {
  NotificationPageDto,
  NotificationSeenResultDto,
} from './dto/notification.dto';

@ApiTags('Notification')
@ApiBearerAuth()
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @ApiOperation({ summary: 'List my notifications (with unread count + filters)' })
  @ApiQuery({ name: 'page', type: 'integer', required: false, example: 1 })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false, example: 50 })
  @ApiQuery({
    name: 'group',
    type: 'string',
    required: false,
    example: 'general',
    description: 'general | creator | all',
  })
  @ApiQuery({
    name: 'networkId',
    type: 'string',
    required: false,
    example: 'network-uuid-1234',
  })
  @ApiQuery({ name: 'isUnreadOnly', type: 'boolean', required: false, example: false })
  @ApiQuery({ name: 'isReadOnly', type: 'boolean', required: false, example: false })
  @ApiResponse({ status: 200, type: () => NotificationPageDto })
  list = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    // FE NotificationQueryRequest defaults perPage to 50.
    const p = parsePagination(req.query as Record<string, unknown>, { perPage: 50 });
    const group = req.query.group as 'general' | 'creator' | 'all' | undefined;
    const networkId = (req.query.networkId as string) ?? undefined;
    const isUnreadOnly = req.query.isUnreadOnly === '1' || req.query.isUnreadOnly === 'true';
    const isReadOnly = req.query.isReadOnly === '1' || req.query.isReadOnly === 'true';

    const { rows, total, totalAll, unread } = await this.notificationService.listForMember(
      p,
      req.user.id,
      { group, networkId, isUnreadOnly, isReadOnly },
    );

    const items = rows.map(serializeNotification);
    const page = buildLegacyPage(items, total, p, totalAll);
    return ok(res, { ...page, unread });
  };

  @ApiOperation({ summary: 'Mark notifications as seen (single id, ids array, or markAllRead)' })
  @ApiResponse({ status: 200, type: () => NotificationSeenResultDto })
  seen = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const notificationId = typeof body.notificationId === 'string' ? body.notificationId : undefined;
    const notificationIds = Array.isArray(body.notificationIds)
      ? (body.notificationIds as string[])
      : undefined;
    const markAllRead = body.markAllRead === true || body.markAllRead === 'true';
    const result = await this.notificationService.markSeen(req.user.id, {
      notificationId,
      notificationIds,
      markAllRead,
    });
    return ok(res, { updated: result.count });
  };
}
