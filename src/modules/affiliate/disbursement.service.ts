import { prisma } from '@bb/db';
import { BadRequestException } from '@/common/exceptions';
import { COMMISSION_STATUS, DISBURSEMENT_STATUS } from './constants';
import { quoteDisbursement } from './utils/disbursement-calc';

/**
 * Affiliate payout (disbursement) domain.
 *
 * Ledger model (no separate wallet table): withdrawable balance =
 *   SUM(commission.amount where status = BALANCE)            // cleared earnings
 *   - SUM(disbursement.grossAmount where status in PENDING|PAID)  // in-flight / paid out
 * FAILED / VOIDED disbursements release their balance automatically (excluded above).
 */
export class DisbursementService {
  async getWithdrawableBalance(memberId: string): Promise<number> {
    const [commissionAgg, disbursementAgg] = await Promise.all([
      prisma.affiliateCommission.aggregate({
        where: { recipientId: memberId, status: COMMISSION_STATUS.BALANCE },
        _sum: { amount: true },
      }),
      prisma.affiliateDisbursement.aggregate({
        where: {
          memberId,
          status: { in: [DISBURSEMENT_STATUS.PENDING, DISBURSEMENT_STATUS.PAID] },
        },
        _sum: { grossAmount: true },
      }),
    ]);
    const cleared = commissionAgg._sum.amount ?? 0;
    const consumed = disbursementAgg._sum.grossAmount ?? 0;
    return Math.max(0, cleared - consumed);
  }

  async getSummary(memberId: string) {
    const balance = await this.getWithdrawableBalance(memberId);
    const quote = quoteDisbursement(balance);
    const pendingDisbursement = await prisma.affiliateDisbursement.findFirst({
      where: { memberId, status: DISBURSEMENT_STATUS.PENDING },
      orderBy: { requestedAt: 'desc' },
    });
    return {
      withdrawableBalance: balance,
      eligible: quote.eligible && !pendingDisbursement,
      reason: pendingDisbursement ? 'You already have a pending withdrawal' : quote.reason,
      fee: quote.fee,
      netAmount: quote.netAmount,
      hasPendingDisbursement: !!pendingDisbursement,
      pendingDisbursement,
    };
  }

  /**
   * Create a payout request consuming the full withdrawable balance.
   * Blocks concurrent PENDING payouts. Wrapped in a transaction to narrow the race window.
   */
  async requestDisbursement(memberId: string) {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.affiliateDisbursement.findFirst({
        where: { memberId, status: DISBURSEMENT_STATUS.PENDING },
      });
      if (existing) throw new BadRequestException('You already have a pending withdrawal');

      const [commissionAgg, disbursementAgg] = await Promise.all([
        tx.affiliateCommission.aggregate({
          where: { recipientId: memberId, status: COMMISSION_STATUS.BALANCE },
          _sum: { amount: true },
        }),
        tx.affiliateDisbursement.aggregate({
          where: { memberId, status: { in: [DISBURSEMENT_STATUS.PENDING, DISBURSEMENT_STATUS.PAID] } },
          _sum: { grossAmount: true },
        }),
      ]);
      const balance = Math.max(0, (commissionAgg._sum.amount ?? 0) - (disbursementAgg._sum.grossAmount ?? 0));
      const quote = quoteDisbursement(balance);
      if (!quote.eligible) throw new BadRequestException(quote.reason ?? 'Not eligible for withdrawal');

      return tx.affiliateDisbursement.create({
        data: {
          memberId,
          grossAmount: quote.grossAmount,
          fee: quote.fee,
          netAmount: quote.netAmount,
          status: DISBURSEMENT_STATUS.PENDING,
        },
      });
    });
  }

  async listDisbursements(memberId: string, page = 1, perPage = 20) {
    const [rows, total] = await Promise.all([
      prisma.affiliateDisbursement.findMany({
        where: { memberId },
        orderBy: { requestedAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      prisma.affiliateDisbursement.count({ where: { memberId } }),
    ]);
    return { rows, total };
  }

  // --- Payout provider integration point (Xendit) -------------------------------
  // The actual money movement is intentionally NOT wired here. A processor/worker
  // should claim PENDING rows, call the Xendit Disbursement API, then call
  // markPaid / markFailed. markFailed releases the held balance (FAILED is excluded
  // from getWithdrawableBalance).
  async markPaid(id: string, providerRef: string, now: Date = new Date()) {
    return prisma.affiliateDisbursement.update({
      where: { id },
      data: { status: DISBURSEMENT_STATUS.PAID, provider: 'xendit', providerRef, paidAt: now },
    });
  }

  async markFailed(id: string, reason: string) {
    return prisma.affiliateDisbursement.update({
      where: { id },
      data: { status: DISBURSEMENT_STATUS.FAILED, failureReason: reason },
    });
  }
}
