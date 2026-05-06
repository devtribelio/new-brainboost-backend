import { Router } from 'express';
import { LocationController } from './location.controller';
import { LocationService } from './location.service';
import { asyncHandler } from '@/common/utils/async-handler';

export function locationRoutes(): Router {
  const router = Router();
  const ctrl = new LocationController(new LocationService());

  router.get('/data/location/country', asyncHandler(ctrl.listCountries));
  router.get('/data/location/province', asyncHandler(ctrl.listProvinces));
  router.get('/data/location/city', asyncHandler(ctrl.listCities));
  router.get('/data/location/district', asyncHandler(ctrl.listDistricts));

  return router;
}
