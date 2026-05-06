import type { Response } from 'express';
import { NotificationService } from './notification.service';
import { ok } from '@/common/utils/response.util';
import { UnauthorizedException } from '@/common/exceptions';
import { buildPageMeta, parsePagination } from '@/common/utils/pagination.util';
import { serializeNotification } from '@/common/serializers';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';

export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  list = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const p = parsePagination(req.query as Record<string, unknown>);
    const { rows, total, unread } = await this.notificationService.listForMember(p, req.user.id);
    return ok(res, rows.map(serializeNotification), {
      ...buildPageMeta(total, p),
      unread,
    });
  };

  seen = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const ids = Array.isArray(req.body?.notificationIds)
      ? (req.body.notificationIds as string[])
      : undefined;
    const result = await this.notificationService.markSeen(req.user.id, ids);
    return ok(res, { updated: result.count });
  };
}
