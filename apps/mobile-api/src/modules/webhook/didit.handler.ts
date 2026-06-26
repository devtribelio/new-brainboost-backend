import { DisbursementService } from '@bb/domain/affiliate/disbursement.service';
import { logger } from '@bb/common/config/logger';

/**
 * Didit webhook payload (loose — Didit sends several webhook_type/status shapes;
 * we act on the KYC lifecycle statuses and ack the rest so retries stop).
 * `vendor_data` is our member UUID, echoed from session creation; `session_id`
 * is matched against the member's active kycProviderRef downstream.
 * Docs: https://docs.didit.me/integration/webhooks
 */
export interface DiditWebhookPayload {
  webhook_type?: string;
  status?: string; // Approved | Declined | In Review | In Progress | Resubmitted | ...
  session_id?: string;
  vendor_data?: string;
  decision?: Record<string, unknown>;
}

// Statuses that mean "documents in, review underway" → PENDING.
const PENDING_STATUSES = new Set(['In Progress', 'In Review', 'Resubmitted']);

export class DiditWebhookHandler {
  constructor(private readonly disbursement = new DisbursementService()) {}

  async handle(payload: DiditWebhookPayload) {
    const { status, session_id: sessionId, vendor_data: vendorData } = payload;
    if (!status || !sessionId) {
      return { handled: false, reason: 'missing status/session_id' };
    }

    if (status === 'Approved') {
      return this.disbursement.applyDiditReview({ sessionId, vendorData, approved: true });
    }
    if (status === 'Declined') {
      return this.disbursement.applyDiditReview({
        sessionId,
        vendorData,
        approved: false,
        rejectedReason: extractReason(payload.decision),
      });
    }
    if (PENDING_STATUSES.has(status)) {
      return this.disbursement.markDiditPending(sessionId, vendorData);
    }

    // Ack everything else (Not Started, Awaiting User, Abandoned, Expired, ...) so
    // Didit does not retry events we deliberately ignore.
    logger.debug({ status, sessionId }, '[webhook] didit event ignored');
    return { handled: false, reason: `ignored status ${status}` };
  }
}

/** Best-effort short reason from the decision object for a Declined result. */
function extractReason(decision?: Record<string, unknown>): string | null {
  if (!decision) return null;
  const reason = (decision.reason ?? decision.comment) as string | undefined;
  return reason ?? null;
}
