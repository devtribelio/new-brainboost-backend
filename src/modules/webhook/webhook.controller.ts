import type { Request, Response } from 'express';
import { ApiBody, ApiOperation, ApiTags } from '@bb/common/openapi/decorators';
import type { XenditWebhookHandler } from './xendit.handler';
import { XenditInvoiceCallbackDto } from './dto/xendit-callback.dto';

@ApiTags('Webhook')
export class WebhookController {
  constructor(private readonly handler: XenditWebhookHandler) {}

  @ApiOperation({ summary: 'Xendit Invoice callback (paid / expired)' })
  @ApiBody({ type: () => XenditInvoiceCallbackDto })
  xenditInvoice = async (req: Request, res: Response) => {
    const result = await this.handler.handle(req.body as Record<string, unknown>);
    return res.status(200).json({ received: true, ...result });
  };
}
