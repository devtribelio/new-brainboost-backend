import type { Response } from 'express';
import { ok } from '@/common/utils/response.util';
import { ApiOperation, ApiResponse, ApiTags } from '@/common/openapi/decorators';
import { purchaseIngestService, type NormalizedPurchase } from './purchase-ingest.service';
import type { CredentialedRequest } from './credential.guard';

@ApiTags('Ingest')
export class IngestController {
  @ApiOperation({
    summary: 'Ingest a normalized purchase from a 3rd-party channel (auth: ThirdPartyCredential key)',
  })
  @ApiResponse({ status: 200, description: 'Ingest outcome (committed | duplicate | refunded | *_not_found)' })
  ingestPurchase = async (req: CredentialedRequest, res: Response) => {
    const cred = req.credential!; // set by credentialGuard
    const body = (req.body ?? {}) as NormalizedPurchase;
    const result = await purchaseIngestService.ingest(body, cred);
    return ok(res, result);
  };
}
