import type { Request, Response } from 'express';
import { ApiOperation, ApiTags } from '@/common/openapi/decorators';
import type { XenditWebhookHandler } from './xendit.handler';

@ApiTags('Webhook')
export class WebhookController {
  constructor(private readonly handler: XenditWebhookHandler) {}

  @ApiOperation({ summary: 'Xendit Virtual Account callback' })
  xenditVa = async (req: Request, res: Response) => {
    const result = await this.handler.handle('va', req.body as Record<string, unknown>);
    return res.status(200).json({ received: true, ...result });
  };

  @ApiOperation({ summary: 'Xendit eWallet callback' })
  xenditEwallet = async (req: Request, res: Response) => {
    const result = await this.handler.handle('ewallet', req.body as Record<string, unknown>);
    return res.status(200).json({ received: true, ...result });
  };

  @ApiOperation({ summary: 'Xendit Credit Card callback' })
  xenditCc = async (req: Request, res: Response) => {
    const result = await this.handler.handle('cc', req.body as Record<string, unknown>);
    return res.status(200).json({ received: true, ...result });
  };
}
