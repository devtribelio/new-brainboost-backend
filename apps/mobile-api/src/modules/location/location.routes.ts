import { Router } from 'express';
import { LocationController } from './location.controller';
import { LocationService } from './location.service';
import { bindRoute } from '@bb/common/openapi/route-binder';

export function locationRoutes(): Router {
  const router = Router();
  const ctrl = new LocationController(new LocationService());

  bindRoute({ router, controller: ctrl, method: 'get', path: '/data/location/country', handlerKey: 'listCountries' });
  bindRoute({ router, controller: ctrl, method: 'get', path: '/data/location/province', handlerKey: 'listProvinces' });
  bindRoute({ router, controller: ctrl, method: 'get', path: '/data/location/city', handlerKey: 'listCities' });
  bindRoute({ router, controller: ctrl, method: 'get', path: '/data/location/district', handlerKey: 'listDistricts' });

  return router;
}
