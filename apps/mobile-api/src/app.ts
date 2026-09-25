import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { errorHandler, notFoundHandler } from '@bb/common/middlewares/error.middleware';
import { requestLogger } from '@bb/common/middlewares/request-logger.middleware';
import { registerModules } from '@/core/register-modules';
import { shortlinkRouter } from '@/shortlink';
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

  // Access log + per-request context. FIRST in the chain (but after `trust
  // proxy`, which it needs for the client IP) so that a rejected CORS preflight,
  // a 429 or a malformed JSON body still produces a log line, and so every
  // downstream log — middleware, controller, @bb/domain service, Prisma — is
  // stamped with the same requestId. Replaces morgan.
  app.use(requestLogger);

  // JSON API: keep helmet's strict default CSP. The only HTML surface is the
  // Swagger UI at /api/docs, which loosens its own CSP inside mountSwagger().
  app.use(helmet());
  // CORS: no allowlist (CORS_ALLOWED_ORIGINS empty) → default permissive, which
  // is fine for native mobile clients that don't enforce CORS. With an allowlist
  // set, only listed origins get CORS headers and credentials can be enabled for
  // a cookie-using web FE. Unknown origins simply receive no CORS headers (the
  // browser blocks them) instead of a 500 — so we never throw from the callback.
  const corsAllowlist = env.cors.allowedOrigins;
  app.use(
    cors(
      corsAllowlist.length === 0
        ? undefined
        : {
            origin(origin, cb) {
              cb(null, !origin || corsAllowlist.includes(origin));
            },
            credentials: env.cors.credentials,
          },
    ),
  );
  app.use(compression());
  app.use(cookieParser());
  app.use(
    express.json({
      limit: '5mb',
      // Keep the raw body bytes: the Didit webhook signature is an HMAC over the
      // payload AS SENT — re-serializing req.body would not round-trip.
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true }));

  // Uploads now live in S3 (public/* served via CDN) — no local static serving.

  app.get('/health', (_req, res) => ok(res, { status: 'ok', service: env.appName }));

  // Public shortlink redirect. Root-mounted like /health: it answers a 302 to a
  // human's browser, not JSON to the mobile client, so it is not an AppModule
  // (those all live under /api).
  app.use('/s', shortlinkRouter());

  app.use('/api', registerModules());

  // OpenAPI / Swagger UI — mounted AFTER all module routes so the
  // route registry is fully populated before the document is built.
  mountSwagger(app, '/api/docs');

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
