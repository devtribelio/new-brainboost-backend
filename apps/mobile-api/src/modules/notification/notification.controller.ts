import type { Response } from 'express';
import { NotificationService } from '@bb/domain/notification/notification.service';
import { ok, okPaginated } from '@bb/common/utils/response.util';
import { badRequest, unauthorized, ERROR_CODES } from '@bb/common/exceptions';
import { parsePagination } from '@bb/common/utils/pagination.util';
import { serializeNotification } from './notification.serializer';
import type { AuthenticatedRequest } from '@bb/common/interfaces/authenticated-request';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@bb/common/openapi/decorators';
import {
  NotificationDto,
  NotificationMuteDto,
  NotificationMuteResultDto,
  NotificationSeenDto,
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
  @ApiQuery({
    name: 'readStatus',
    type: 'string',
    required: false,
    enum: ['all', 'read', 'unread'],
    example: 'all',
    description: 'Default all. read | unread filters by read state.',
  })
  @ApiResponse({ status: 200, type: () => NotificationDto, isArray: true, envelope: 'paginated' })
  list = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw unauthorized(ERROR_CODES.AUTH_REQUIRED);
    // FE NotificationQueryRequest defaults perPage to 50.
    const p = parsePagination(req.query as Record<string, unknown>, { perPage: 50 });
    const group = req.query.group as 'general' | 'creator' | 'all' | undefined;
    const networkId = (req.query.networkId as string) ?? undefined;
    const readStatus = (['all', 'read', 'unread'] as const).includes(
      req.query.readStatus as 'all' | 'read' | 'unread',
    )
      ? (req.query.readStatus as 'all' | 'read' | 'unread')
      : undefined;
    // Legacy fallbacks — only honoured when readStatus is absent (service precedence).
    const isUnreadOnly = req.query.isUnreadOnly === '1' || req.query.isUnreadOnly === 'true';
    const isReadOnly = req.query.isReadOnly === '1' || req.query.isReadOnly === 'true';

    const { rows, total, totalAll, unread } = await this.notificationService.listForMember(
      p,
      req.user.id,
      { group, networkId, readStatus, isUnreadOnly, isReadOnly },
    );

    const items = rows.map(serializeNotification);
    const extraMeta: Record<string, unknown> = { unread };
    if (totalAll !== undefined) extraMeta.totalAll = totalAll;
    return okPaginated(res, items, { page: p.page, perPage: p.perPage, total }, extraMeta);
  };

  @ApiOperation({ summary: 'Mark notifications as seen (single id, ids array, or markAllRead)' })
  @ApiBody({ type: () => NotificationSeenDto })
  @ApiResponse({ status: 200, type: () => NotificationSeenResultDto })
  seen = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw unauthorized(ERROR_CODES.AUTH_REQUIRED);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const notificationId =
      typeof body.notificationId === 'string' ? body.notificationId : undefined;
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

  // Scope validation lives in NotificationService (assertMuteScope) so mute and
  // unmute cannot drift apart — they used to disagree on which scopes are legal.
  @ApiOperation({
    summary: 'Mute notifications for a post, topic, or network',
    description:
      'Silences every notification originating from that object. Muting a topic also covers comments/replies/tags/likes on posts inside it. Idempotent — muting twice is a no-op.',
  })
  @ApiBody({ type: () => NotificationMuteDto })
  @ApiResponse({ status: 200, type: () => NotificationMuteResultDto })
  mute = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw unauthorized(ERROR_CODES.AUTH_REQUIRED);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const scope = typeof body.scope === 'string' ? body.scope : '';
    const refId = typeof body.refId === 'string' ? body.refId : '';
    if (!scope || !refId) throw badRequest(ERROR_CODES.NOTIFICATION_SCOPE_REQUIRED);
    return ok(res, await this.notificationService.mute(req.user.id, scope, refId));
  };

  @ApiOperation({
    summary: 'Unmute notifications for a post, topic, or network',
    description: 'Reverses /mute with the same scope + refId. Unmuting what was never muted is a no-op.',
  })
  @ApiBody({ type: () => NotificationMuteDto })
  @ApiResponse({ status: 200, type: () => NotificationMuteResultDto })
  unmute = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw unauthorized(ERROR_CODES.AUTH_REQUIRED);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const scope = typeof body.scope === 'string' ? body.scope : '';
    const refId = typeof body.refId === 'string' ? body.refId : '';
    if (!scope || !refId) throw badRequest(ERROR_CODES.NOTIFICATION_SCOPE_REQUIRED);
    return ok(res, await this.notificationService.unmute(req.user.id, scope, refId));
  };
}
