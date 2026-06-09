import { logger } from '@bb/common/config/logger';
import { DisbursementService } from '@bb/domain/affiliate/disbursement.service';

type RawPayload = Record<string, unknown>;

export interface HandleResult {
  noop: boolean;
  reason?: string;
}

/**
 * Xendit Disbursement webhook handler (legacy /disbursements API callback).
 *
 * Flat envelope — fields at root. Status flow we care about:
 *   COMPLETED → markPaid     (status PAID)
 *   FAILED    → markFailed   (status FAILED — frees the held balance)
 *
 * Idempotency: we match by `external_id` and the service's conditional update
 * (only transitions PENDING|PROCESSING) makes a replayed callback a no-op — it
 * can NEVER double-pay. Always returns 200-shaped result so Xendit stops retrying
 * a resolved event; genuine DB failures throw → 5xx → Xendit retries.
 */
export class XenditDisbursementWebhookHandler {
  constructor(private readonly disbursementService = new DisbursementService()) {}

  async handle(payload: RawPayload): Promise<HandleResult> {
    const externalId = payload['external_id'] as string | undefined;
    const status = (payload['status'] as string | undefined)?.toUpperCase();
    const xenditId = payload['id'] as string | undefined;
    const failureCode = payload['failure_code'] as string | undefined;

    if (!externalId) {
      logger.warn({ payload }, '[webhook] disbursement missing external_id');
      return { noop: true, reason: 'missing_external_id' };
    }

    if (status === 'COMPLETED') {
      const r = await this.disbursementService.markPaidByExternalId(externalId, xenditId);
      return { noop: r.count === 0, reason: r.count === 0 ? 'unknown_or_terminal' : undefined };
    }

    if (status === 'FAILED') {
      const reason = failureCode || 'Xendit disbursement failed';
      const r = await this.disbursementService.markFailedByExternalId(externalId, reason);
      return { noop: r.count === 0, reason: r.count === 0 ? 'unknown_or_terminal' : undefined };
    }

    logger.info({ externalId, status }, '[webhook] disbursement non-terminal status — noop');
    return { noop: true, reason: 'non_terminal_status' };
  }
}
