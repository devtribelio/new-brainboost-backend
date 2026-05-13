import path from 'node:path';
import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { errorHandler, notFoundHandler } from '@/common/middlewares/error.middleware';
import { registerModules } from '@/core/register-modules';
import { adminRoutes } from '@/modules/admin/admin.routes';
import { mountSwagger } from '@/common/openapi/swagger.middleware';
import { ok } from '@/common/utils/response.util';
import { env } from '@/config/env';
import { registerCommerceListeners } from '@/modules/commerce/listeners/payment-success.listener';

let listenersRegistered = false;

export function buildApp(): Express {
  if (!listenersRegistered) {
    registerCommerceListeners();
    listenersRegistered = true;
  }
  const app = express();

  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: false,
    }),
  );
  app.use(cors());
  app.use(compression());
  app.use(cookieParser());
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));

  if (!env.isTest) {
    app.use(morgan(env.isProduction ? 'combined' : 'dev'));
  }

  app.set('view engine', 'ejs');
  app.set('views', path.join(process.cwd(), 'views'));
  app.use('/admin/static', express.static(path.join(process.cwd(), 'public/admin')));
  app.use('/static/temporary', express.static(path.resolve(process.cwd(), env.upload.tempDir)));

  app.get('/health', (_req, res) => ok(res, { status: 'ok', service: env.appName }));

  app.use('/admin', adminRoutes());
  app.use('/api', registerModules());

  // OpenAPI / Swagger UI — mounted AFTER all module routes so the
  // route registry is fully populated before the document is built.
  mountSwagger(app, '/api/docs');

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
