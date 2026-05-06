import type { Request, Response } from 'express';
import { LocationService } from './location.service';
import { notImplemented } from '@/common/utils/response.util';

export class LocationController {
  constructor(private readonly _locationService: LocationService) {}

  listCountries = async (_req: Request, res: Response) =>
    notImplemented(res, 'location.listCountries');
  listProvinces = async (_req: Request, res: Response) =>
    notImplemented(res, 'location.listProvinces');
  listCities = async (_req: Request, res: Response) => notImplemented(res, 'location.listCities');
  listDistricts = async (_req: Request, res: Response) =>
    notImplemented(res, 'location.listDistricts');
}
