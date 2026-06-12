import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { errorHandler, notFoundHandler } from '@bb/common/middlewares/error.middleware';
import { registerModules } from '@/core/register-modules';
import { mountSwagger } from '@bb/common/openapi/swagger.middleware';
import { ok } from '@bb/common/utils/response.util';
import { env } from '@bb/common/config/env';
import { registerDomainListeners } from '@bb/domain';

let listenersRegistered = false;

export function buildApp(): Express {
  if (!listenersRegistered) {
    registerDomainListeners();
    listenersRegistered = true;
  }
  const app = express();

  app.disable('x-powered-by');

  // Behind a reverse proxy / load balancer the real client IP arrives in
  // X-Forwarded-For. `trust proxy` makes req.ip reflect it, so per-IP rate
  // limiting keys on the actual client instead of the proxy. Off unless
  // TRUST_PROXY is set (see env.ts). A numeric value is treated as a hop
  // count; any other value is passed to Express as-is (e.g. "loopback").
  if (env.trustProxy) {
    const hops = Number(env.trustProxy);
    app.set('trust proxy', Number.isNaN(hops) ? env.trustProxy : hops);
  }

  app.use(
    helmet({
      contentSecurityPolicy: false,
    }),
  );
  app.use(cors());
  app.use(compression());
  app.use(cookieParser());
  app.use(
    express.json({
      limit: '5mb',
      // Keep the raw body bytes: the Sumsub webhook digest is an HMAC over the
      // payload AS SENT — re-serializing req.body would not round-trip.
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true }));

  if (!env.isTest) {
    app.use(morgan(env.isProduction ? 'combined' : 'dev'));
  }

  // Uploads now live in S3 (public/* served via CDN) — no local static serving.

  app.get('/health', (_req, res) => ok(res, { status: 'ok', service: env.appName }));

  app.use('/api', registerModules());

  // OpenAPI / Swagger UI — mounted AFTER all module routes so the
  // route registry is fully populated before the document is built.
  mountSwagger(app, '/api/docs');

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
