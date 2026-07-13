import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { DisbursementService } from '@bb/domain/affiliate/disbursement.service';
import { DISBURSEMENT_STATUS } from '@bb/domain/affiliate/constants';

/**
 * Background job: fire approved-but-not-yet-sent payouts to Xendit.
 *
 * Picks up rows `status=PENDING AND approved_at IS NOT NULL`, which covers:
 *  - MANUAL rows approved from the backoffice dashboard (backoffice-bb only
 *    stamps `approved_at`/`approved_by` via SQL — the Xendit call and the
 *    secret key stay in this codebase, single owner of the state machine).
 *  - AUTO rows whose inline `disburseViaXendit` never ran because the process
 *    died between self-approval and the provider call (self-heal).
 *
 * KYC is re-checked HERE, not just at request time: between request and
 * approval the member may have gone EXPIRED (bank change / dormant / large
 * payout re-KYC). A non-APPROVED member's row is flipped to FAILED, which
 * frees the held balance — the member re-requests after re-verifying.
 *
 * Concurrency: the jobs-runner is a single scheduled process, and Xendit's
 * X-IDEMPOTENCY-KEY (= externalId) backstops any double call. Rows already
 * moved off PENDING by an earlier attempt are simply not selected again.
 */
export async function executeApprovedDisbursements(
  disbursementService: DisbursementService = new DisbursementService(),
): Promise<{ sent: number; failed: number; kycBlocked: number }> {
  const rows = await prisma.affiliateDisbursement.findMany({
    where: { status: DISBURSEMENT_STATUS.PENDING, approvedAt: { not: null } },
    orderBy: { approvedAt: 'asc' },
    include: { member: { select: { kycStatus: true } } },
  });

  let sent = 0;
  let failed = 0;
  let kycBlocked = 0;

  for (const row of rows) {
    try {
      if (row.member.kycStatus !== 'APPROVED') {
        await prisma.affiliateDisbursement.update({
          where: { id: row.id },
          data: {
            status: DISBURSEMENT_STATUS.FAILED,
            failureReason: `KYC tidak APPROVED saat eksekusi (${row.member.kycStatus})`,
          },
        });
        kycBlocked += 1;
        logger.warn(
          { disbursementId: row.id, memberId: row.memberId, kycStatus: row.member.kycStatus },
          '[jobs] approved disbursement blocked by KYC recheck',
        );
        continue;
      }

      const result = await disbursementService.disburseViaXendit(row);
      if (result.status === DISBURSEMENT_STATUS.PROCESSING) sent += 1;
      else failed += 1;
    } catch (err) {
      failed += 1;
      logger.error({ disbursementId: row.id, err }, '[jobs] execute approved disbursement failed');
    }
  }

  if (rows.length > 0) {
    logger.info({ picked: rows.length, sent, failed, kycBlocked }, '[jobs] executeApprovedDisbursements done');
  }
  return { sent, failed, kycBlocked };
}
