import path from 'node:path';
import express, { type Express } from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { errorHandler, notFoundHandler } from '@bb/common/middlewares/error.middleware';
import { adminRoutes } from '@/modules/admin/admin.routes';
import { ok } from '@bb/common/utils/response.util';
import { env } from '@bb/common/config/env';
import { registerDomainListeners } from '@bb/domain';

let listenersRegistered = false;

export function buildApp(): Express {
  // Curation actions emit domain events (e.g. post/comment moderation). The
  // notification listeners run in-process, so register them here too.
  if (!listenersRegistered) {
    registerDomainListeners();
    listenersRegistered = true;
  }
  const app = express();

  app.disable('x-powered-by');

  if (env.trustProxy) {
    const hops = Number(env.trustProxy);
    app.set('trust proxy', Number.isNaN(hops) ? env.trustProxy : hops);
  }

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));

  if (!env.isTest) {
    app.use(morgan(env.isProduction ? 'combined' : 'dev'));
  }

  // Resolve views/static relative to this file (src in dev, dist in prod)
  // so it works regardless of process.cwd() (e.g. vitest workspace runs).
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use('/admin/static', express.static(path.join(__dirname, '..', 'public', 'admin')));

  app.get('/health', (_req, res) => ok(res, { status: 'ok', service: 'admin-ejs' }));

  app.use('/admin', adminRoutes());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
