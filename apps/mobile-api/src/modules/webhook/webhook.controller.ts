import type { Request, Response } from 'express';
import { ApiBody, ApiOperation, ApiTags } from '@bb/common/openapi/decorators';
import type { XenditWebhookHandler } from './xendit.handler';
import type { RevenueCatWebhookHandler } from './revenuecat.handler';
import type { XenditDisbursementWebhookHandler } from './xendit-disbursement.handler';
import { XenditInvoiceCallbackDto } from './dto/xendit-callback.dto';
import { RevenueCatCallbackDto } from './dto/revenuecat-callback.dto';
import { XenditDisbursementCallbackDto } from './dto/xendit-disbursement-callback.dto';

@ApiTags('Webhook')
export class WebhookController {
  constructor(
    private readonly xendit: XenditWebhookHandler,
    private readonly revenuecat: RevenueCatWebhookHandler,
    private readonly xenditDisbursement: XenditDisbursementWebhookHandler,
  ) {}

  @ApiOperation({ summary: 'Xendit Invoice callback (paid / expired)' })
  @ApiBody({ type: () => XenditInvoiceCallbackDto })
  xenditInvoice = async (req: Request, res: Response) => {
    const result = await this.xendit.handle(req.body as Record<string, unknown>);
    return res.status(200).json({ received: true, ...result });
  };

  @ApiOperation({
    summary: 'RevenueCat webhook (IAP purchase / refund → grants or revokes course access)',
  })
  @ApiBody({ type: () => RevenueCatCallbackDto })
  revenuecatWebhook = async (req: Request, res: Response) => {
    const { event } = req.body as RevenueCatCallbackDto;
    const result = await this.revenuecat.handle(event);
    // Always 200 on a processed event so RC does not retry resolved outcomes;
    // genuine transient failures (DB down) throw → errorHandler 5xx → RC retries.
    return res.status(200).json({ received: true, ...result });
  };

  @ApiOperation({ summary: 'Xendit Disbursement callback (COMPLETED → paid / FAILED → released)' })
  @ApiBody({ type: () => XenditDisbursementCallbackDto })
  xenditDisbursementCallback = async (req: Request, res: Response) => {
    const result = await this.xenditDisbursement.handle(req.body as Record<string, unknown>);
    return res.status(200).json({ received: true, ...result });
  };
}
