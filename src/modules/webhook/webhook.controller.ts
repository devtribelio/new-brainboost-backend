import type { Request, Response } from 'express';
import { ApiBody, ApiOperation, ApiTags } from '@/common/openapi/decorators';
import type { XenditWebhookHandler } from './xendit.handler';
import {
  XenditCcCallbackDto,
  XenditEwalletCallbackDto,
  XenditVaCallbackDto,
} from './dto/xendit-callback.dto';

@ApiTags('Webhook')
export class WebhookController {
  constructor(private readonly handler: XenditWebhookHandler) {}

  @ApiOperation({ summary: 'Xendit Virtual Account callback' })
  @ApiBody({ type: () => XenditVaCallbackDto })
  xenditVa = async (req: Request, res: Response) => {
    const result = await this.handler.handle('va', req.body as Record<string, unknown>);
    return res.status(200).json({ received: true, ...result });
  };

  @ApiOperation({ summary: 'Xendit eWallet callback' })
  @ApiBody({ type: () => XenditEwalletCallbackDto })
  xenditEwallet = async (req: Request, res: Response) => {
    const result = await this.handler.handle('ewallet', req.body as Record<string, unknown>);
    return res.status(200).json({ received: true, ...result });
  };

  @ApiOperation({ summary: 'Xendit Credit Card callback' })
  @ApiBody({ type: () => XenditCcCallbackDto })
  xenditCc = async (req: Request, res: Response) => {
    const result = await this.handler.handle('cc', req.body as Record<string, unknown>);
    return res.status(200).json({ received: true, ...result });
  };
}
