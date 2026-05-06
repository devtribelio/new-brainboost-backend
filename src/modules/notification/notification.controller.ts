import type { Request, Response } from 'express';
import { NotificationService } from './notification.service';
import { notImplemented } from '@/common/utils/response.util';

export class NotificationController {
  constructor(private readonly _notificationService: NotificationService) {}

  list = async (_req: Request, res: Response) => notImplemented(res, 'notification.list');
  seen = async (_req: Request, res: Response) => notImplemented(res, 'notification.seen');
}
