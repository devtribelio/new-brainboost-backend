import { Router } from 'express';
import { IngestController } from './ingest.controller';
import { credentialGuard } from './credential.guard';
import { bindRoute } from '@/common/openapi/route-binder';

export function ingestRoutes(): Router {
  const router = Router();
  const ctrl = new IngestController();

  // POST /api/ingest/purchase  (authenticated by ThirdPartyCredential, not member auth)
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/purchase',
    handlerKey: 'ingestPurchase',
    middlewares: [credentialGuard],
  });

  return router;
}
