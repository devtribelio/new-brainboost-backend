import type { Request, Response } from 'express';
import { ProfileService } from './profile.service';
import { notImplemented } from '@/common/utils/response.util';

export class ProfileController {
  constructor(private readonly _profileService: ProfileService) {}

  getInfo = async (_req: Request, res: Response) => notImplemented(res, 'profile.getInfo');
  update = async (_req: Request, res: Response) => notImplemented(res, 'profile.update');
  updateLocation = async (_req: Request, res: Response) =>
    notImplemented(res, 'profile.updateLocation');
}
