import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { errorHandler, notFoundHandler } from '@/common/middlewares/error.middleware';
import { registerModules } from '@/core/register-modules';
import { ok } from '@/common/utils/response.util';
import { env } from '@/config/env';

export function buildApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors());
  app.use(compression());
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));

  if (!env.isTest) {
    app.use(morgan(env.isProduction ? 'combined' : 'dev'));
  }

  app.get('/health', (_req, res) => ok(res, { status: 'ok', service: env.appName }));

  app.use('/api', registerModules());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
