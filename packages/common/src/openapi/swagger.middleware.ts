import type { Express, Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiDocument } from './builder';
import { env } from '@bb/common/config/env';

export function mountSwagger(app: Express, prefix = '/api/docs'): void {
  // Build once after all module routes have been registered.
  const document = buildOpenApiDocument({
    info: {
      title: `${env.appName} API`,
      description:
        'Brainboost / Tribelio mobile API. Field naming follows the legacy ' +
        'tribelio-platform contract so the existing Flutter client stays compatible.',
      version: '0.1.0',
    },
    servers: [{ url: '/', description: 'Current host' }],
    pathPrefix: '/api',
  });

  app.get(`${prefix}.json`, (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    res.json(document);
  });

  app.use(
    prefix,
    swaggerUi.serve,
    swaggerUi.setup(document, {
      explorer: true,
      swaggerOptions: { persistAuthorization: true },
      customSiteTitle: `${env.appName} API docs`,
    }),
  );
}
