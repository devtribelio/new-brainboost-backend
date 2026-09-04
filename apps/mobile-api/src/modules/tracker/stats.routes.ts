import { traceService } from '@bb/common/utils/trace-service';
import { Router } from 'express';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';
import { authGuard } from '@bb/common/middlewares/auth.middleware';
import { bindRoute } from '@bb/common/openapi/route-binder';
import { validateDto } from '@bb/common/middlewares/validation.middleware';
import { StreakCalendarQueryDto } from './dto/streak-calendar.query.dto';

export function statsRoutes(): Router {
  const router = Router();
  const ctrl = new StatsController(traceService(new StatsService()));

  bindRoute({
    router,
    controller: ctrl,
    method: 'get',
    path: '/stats/home',
    handlerKey: 'home',
    middlewares: [authGuard],
  });

  bindRoute({
    router,
    controller: ctrl,
    method: 'get',
    path: '/stats/streak/calendar',
    handlerKey: 'streakCalendar',
    middlewares: [authGuard, validateDto(StreakCalendarQueryDto, 'query')],
  });

  bindRoute({
    router,
    controller: ctrl,
    method: 'get',
    path: '/stats/course/:courseId',
    handlerKey: 'courseStats',
    middlewares: [authGuard],
  });

  return router;
}
