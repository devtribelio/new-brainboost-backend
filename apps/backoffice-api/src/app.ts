import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { errorHandler, notFoundHandler } from '@bb/common/middlewares/error.middleware';
import { withModulePrefix } from '@bb/common/openapi/registry';
import { mountSwagger } from '@bb/common/openapi/swagger.middleware';
import { ok } from '@bb/common/utils/response.util';
import { env } from '@bb/common/config/env';
import { BackofficeModule } from './backoffice.module';

export function buildApp(): Express {
  const app = express();

  app.disable('x-powered-by');

  if (env.trustProxy) {
    const hops = Number(env.trustProxy);
    app.set('trust proxy', Number.isNaN(hops) ? env.trustProxy : hops);
  }

  // JSON API: keep helmet's strict default CSP. The only HTML surface is the
  // Swagger UI at /api/docs, which loosens its own CSP inside mountSwagger().
  app.use(helmet());
  app.use(cors());
  app.use(compression());
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (_req, res) => ok(res, { status: 'ok', service: 'backoffice-api' }));

  const api = express.Router();
  const router = withModulePrefix(BackofficeModule.prefix, () => BackofficeModule.routes());
  api.use(BackofficeModule.prefix, router);
  app.use('/api', api);

  mountSwagger(app, '/api/docs');

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
