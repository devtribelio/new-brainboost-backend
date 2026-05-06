import type { Request, Response } from 'express';
import { NetworkService } from './network.service';
import { notImplemented } from '@/common/utils/response.util';

export class NetworkController {
  constructor(private readonly _networkService: NetworkService) {}

  join = async (_req: Request, res: Response) => notImplemented(res, 'network.join');
  members = async (_req: Request, res: Response) => notImplemented(res, 'network.members');
  tags = async (_req: Request, res: Response) => notImplemented(res, 'network.tags');
}
