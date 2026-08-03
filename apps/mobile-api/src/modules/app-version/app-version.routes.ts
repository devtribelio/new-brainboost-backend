import { Router } from 'express';
import { traceService } from '@bb/common/utils/trace-service';
import { bindRoute } from '@bb/common/openapi/route-binder';
import { validateDto } from '@bb/common/middlewares/validation.middleware';
import { AppVersionController } from './app-version.controller';
import { AppVersionService } from './app-version.service';
import { VersionCheckQueryDto } from './dto/version-check.query.dto';

export function appVersionRoutes(): Router {
  const router = Router();
  const ctrl = new AppVersionController(traceService(new AppVersionService()));

  // NO authGuard — deliberately public. See the controller doc: the client sends whatever
  // bearer it holds (possibly expired) and this route must never answer 401.
  bindRoute({
    router,
    controller: ctrl,
    method: 'get',
    path: '/version-check',
    handlerKey: 'check',
    middlewares: [validateDto(VersionCheckQueryDto, 'query')],
  });

  return router;
}
