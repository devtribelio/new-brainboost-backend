import { DisbursementService } from '@bb/domain/affiliate/disbursement.service';
import { logger } from '@bb/common/config/logger';

/**
 * Sumsub webhook payload (loose — Sumsub sends 20+ types; we only act on the
 * KYC lifecycle ones and ack the rest so Sumsub stops retrying).
 * Docs: https://docs.sumsub.com/docs/user-verification-webhooks
 */
export interface SumsubWebhookPayload {
  type?: string;
  applicantId?: string;
  externalUserId?: string;
  levelName?: string;
  reviewResult?: {
    reviewAnswer?: string; // GREEN | RED
    rejectLabels?: string[];
    reviewRejectType?: string; // FINAL | RETRY
  };
}

export class SumsubWebhookHandler {
  constructor(private readonly disbursement = new DisbursementService()) {}

  async handle(payload: SumsubWebhookPayload) {
    const { type, applicantId, externalUserId } = payload;
    if (!type || !applicantId) {
      return { handled: false, reason: 'missing type/applicantId' };
    }

    switch (type) {
      case 'applicantPending':
        return this.disbursement.markSumsubPending(applicantId, externalUserId);

      case 'applicantReviewed': {
        const review = payload.reviewResult;
        if (!review?.reviewAnswer) return { handled: false, reason: 'missing reviewResult' };
        return this.disbursement.applySumsubReview({
          applicantId,
          externalUserId,
          reviewAnswer: review.reviewAnswer,
          rejectLabels: review.rejectLabels,
          reviewRejectType: review.reviewRejectType,
        });
      }

      default:
        // Ack everything else (applicantCreated, applicantPrechecked, ...) so
        // Sumsub does not retry events we deliberately ignore.
        logger.debug({ type, applicantId }, '[webhook] sumsub event ignored');
        return { handled: false, reason: `ignored type ${type}` };
    }
  }
}
