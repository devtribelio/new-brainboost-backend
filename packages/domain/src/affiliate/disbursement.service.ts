import { prisma } from '@bb/db';
import { BadRequestException, NotFoundException } from '@bb/common/exceptions';
import { logger } from '@bb/common/config/logger';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import {
  createDisbursement,
  type CreateDisbursementResult,
} from '@bb/common/services/xendit.client';
import { generateExternalId } from '@bb/common/services/xendit-signature';
import {
  COMMISSION_STATUS,
  DISBURSEMENT_STATUS,
  DISBURSEMENT_HOLD_STATUSES,
  DISBURSEMENT_AUTO_APPROVE_MAX,
  DISBURSEMENT_AUTO_MAX_PER_DAY,
  DISBURSEMENT_AUTO_MAX_PER_WEEK,
} from './constants';
import { quoteDisbursement } from './utils/disbursement-calc';

// Mutable array → Prisma `in` filter for HOLD statuses.
const HOLD: string[] = [...DISBURSEMENT_HOLD_STATUSES];

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

interface BalanceInputs {
  cleared: number; // SUM(commission.amount where BALANCE)
  consumed: number; // SUM(disbursement.grossAmount where status HELD)
}

/** Minimal shape needed to fire a payout to Xendit. */
interface DisbursableRow {
  id: string;
  netAmount: number;
  externalId: string | null;
  bankCode: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
}

/**
 * Affiliate payout (disbursement) domain — REAL MONEY.
 *
 * Ledger model (no separate wallet table). Withdrawable balance =
 *   SUM(commission.amount where status = BALANCE)                              // cleared earnings
 *   - SUM(disbursement.grossAmount where status in {PENDING,PROCESSING,PAID})  // HELD
 *
 * HELD statuses (DISBURSEMENT_HOLD_STATUSES) are the ONLY ones that subtract.
 * FAILED / REJECTED / VOIDED are excluded, so a rejected or failed payout
 * automatically frees the balance again (no manual credit-back, no double-spend).
 */
export class DisbursementService {
  // ---- balance ------------------------------------------------------------

  private async balanceInputs(
    memberId: string,
    db: Tx | typeof prisma = prisma,
  ): Promise<BalanceInputs> {
    const [commissionAgg, disbursementAgg] = await Promise.all([
      db.affiliateCommission.aggregate({
        where: { recipientId: memberId, status: COMMISSION_STATUS.BALANCE },
        _sum: { amount: true },
      }),
      db.affiliateDisbursement.aggregate({
        where: { memberId, status: { in: HOLD } },
        _sum: { grossAmount: true },
      }),
    ]);
    return {
      cleared: commissionAgg._sum.amount ?? 0,
      consumed: disbursementAgg._sum.grossAmount ?? 0,
    };
  }

  async getWithdrawableBalance(memberId: string): Promise<number> {
    const { cleared, consumed } = await this.balanceInputs(memberId);
    return Math.max(0, cleared - consumed);
  }

  async getSummary(memberId: string) {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: {
        kycStatus: true,
        bankCode: true,
        bankAccountNumber: true,
        bankAccountName: true,
      },
    });

    const balance = await this.getWithdrawableBalance(memberId);
    const quote = quoteDisbursement(balance);

    // An OPEN payout (PENDING awaiting approval, or PROCESSING awaiting callback)
    // blocks a new request.
    const openDisbursement = await prisma.affiliateDisbursement.findFirst({
      where: {
        memberId,
        status: { in: [DISBURSEMENT_STATUS.PENDING, DISBURSEMENT_STATUS.PROCESSING] },
      },
      orderBy: { requestedAt: 'desc' },
    });

    const kycApproved = member?.kycStatus === 'APPROVED';
    const hasBank = !!(member?.bankCode && member?.bankAccountNumber && member?.bankAccountName);

    let reason = quote.reason ?? null;
    if (!kycApproved) reason = 'KYC belum disetujui';
    else if (!hasBank) reason = 'Rekening belum diisi';
    else if (openDisbursement) reason = 'You already have a pending withdrawal';

    return {
      withdrawableBalance: balance,
      eligible: quote.eligible && kycApproved && hasBank && !openDisbursement,
      reason,
      fee: quote.fee,
      netAmount: quote.netAmount,
      kycStatus: member?.kycStatus ?? 'NONE',
      hasBankAccount: hasBank,
      hasPendingDisbursement: !!openDisbursement,
      pendingDisbursement: openDisbursement,
    };
  }

  // ---- request ------------------------------------------------------------

  /**
   * Create a payout request consuming the full withdrawable balance.
   *
   * Gates: KYC APPROVED + bank account on profile. Decides AUTO vs MANUAL via
   * legacy TBWithdraw::validateStatus parity. The row is created (status PENDING)
   * inside a concurrency-guarded transaction. If AUTO, Xendit is called AFTER
   * the transaction commits (network I/O must not hold a DB tx open).
   */
  async requestDisbursement(memberId: string) {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: {
        kycStatus: true,
        bankCode: true,
        bankAccountNumber: true,
        bankAccountName: true,
      },
    });
    if (!member) throw new NotFoundException('Member not found');
    if (member.kycStatus !== 'APPROVED') throw new BadRequestException('KYC belum disetujui');
    if (!member.bankCode || !member.bankAccountNumber || !member.bankAccountName) {
      throw new BadRequestException('Rekening belum diisi');
    }

    const created = await prisma.$transaction(async (tx) => {
      const existing = await tx.affiliateDisbursement.findFirst({
        where: {
          memberId,
          status: { in: [DISBURSEMENT_STATUS.PENDING, DISBURSEMENT_STATUS.PROCESSING] },
        },
      });
      if (existing) throw new BadRequestException('You already have a pending withdrawal');

      const { cleared, consumed } = await this.balanceInputs(memberId, tx);
      const balance = Math.max(0, cleared - consumed);
      const quote = quoteDisbursement(balance);
      if (!quote.eligible) throw new BadRequestException(quote.reason ?? 'Not eligible for withdrawal');

      const mode = await this.decideMode(memberId, quote.netAmount, tx);

      return tx.affiliateDisbursement.create({
        data: {
          memberId,
          grossAmount: quote.grossAmount,
          fee: quote.fee,
          netAmount: quote.netAmount,
          status: DISBURSEMENT_STATUS.PENDING,
          mode,
          externalId: generateExternalId('disb'),
          bankCode: member.bankCode,
          bankAccountNumber: member.bankAccountNumber,
          bankAccountName: member.bankAccountName,
        },
      });
    });

    // AUTO → self-approve + fire to Xendit immediately. The row already HOLDS the
    // balance (PENDING is a HOLD status), so a failed Xendit call frees it again
    // by flipping to FAILED. No money is created or lost by this ordering.
    if (created.mode === 'AUTO') {
      const approved = await prisma.affiliateDisbursement.update({
        where: { id: created.id },
        data: { approvedAt: new Date() },
      });
      return this.disburseViaXendit(approved);
    }

    return created;
  }

  /**
   * AUTO vs MANUAL — port of legacy TBWithdraw::validateStatus.
   * AUTO requires ALL of:
   *   1. member has a prior PAID disbursement (first-time is ALWAYS manual)
   *   2. netAmount <= autoApproveMax (app_settings `disbursement.autoApproveMax`)
   *   3. <=1 disbursement today AND <=3 this week (counting PROCESSING|PAID)
   * Otherwise MANUAL.
   */
  private async decideMode(
    memberId: string,
    netAmount: number,
    db: Tx | typeof prisma = prisma,
  ): Promise<'AUTO' | 'MANUAL'> {
    // (1) prior successful payout? First-time withdrawers are always reviewed.
    const priorPaid = await db.affiliateDisbursement.count({
      where: { memberId, status: DISBURSEMENT_STATUS.PAID },
    });
    if (priorPaid === 0) return 'MANUAL';

    // (2) under the auto cap?
    const autoMax = await settingsService.getNumber(
      SETTING_KEYS.disbursementAutoApproveMax,
      DISBURSEMENT_AUTO_APPROVE_MAX,
    );
    if (netAmount > autoMax) return 'MANUAL';

    // (3) velocity: count in-flight + paid payouts today / this week.
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const startOfWeek = startOfWeekMonday(now);
    const velocityStatuses = [DISBURSEMENT_STATUS.PROCESSING, DISBURSEMENT_STATUS.PAID];

    const [todayCount, weekCount] = await Promise.all([
      db.affiliateDisbursement.count({
        where: { memberId, status: { in: velocityStatuses }, requestedAt: { gte: startOfDay } },
      }),
      db.affiliateDisbursement.count({
        where: { memberId, status: { in: velocityStatuses }, requestedAt: { gte: startOfWeek } },
      }),
    ]);
    if (todayCount > DISBURSEMENT_AUTO_MAX_PER_DAY - 1) return 'MANUAL';
    if (weekCount > DISBURSEMENT_AUTO_MAX_PER_WEEK - 1) return 'MANUAL';

    return 'AUTO';
  }

  // ---- provider (Xendit) --------------------------------------------------

  /**
   * Call Xendit and move the row PENDING -> PROCESSING. On any error we flip the
   * row to FAILED (which frees the held balance) and swallow — the caller still
   * gets a row back describing the outcome. The provider callback later moves
   * PROCESSING -> PAID / FAILED.
   */
  async disburseViaXendit(row: DisbursableRow) {
    const externalId = row.externalId;
    if (!externalId || !row.bankCode || !row.bankAccountNumber || !row.bankAccountName) {
      // Should never happen (set at request time) — fail safe + free the balance.
      logger.error({ disbursementId: row.id }, '[disbursement] missing bank snapshot / externalId');
      return prisma.affiliateDisbursement.update({
        where: { id: row.id },
        data: { status: DISBURSEMENT_STATUS.FAILED, failureReason: 'Missing bank/external_id' },
      });
    }

    let result: CreateDisbursementResult;
    try {
      result = await createDisbursement({
        externalId,
        amount: row.netAmount,
        bankCode: row.bankCode,
        accountHolderName: row.bankAccountName,
        accountNumber: row.bankAccountNumber,
        description: `Affiliate payout ${externalId}`,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Xendit disbursement failed';
      logger.error(
        { disbursementId: row.id, externalId, err: reason },
        '[disbursement] xendit call failed',
      );
      return prisma.affiliateDisbursement.update({
        where: { id: row.id },
        data: { status: DISBURSEMENT_STATUS.FAILED, failureReason: reason },
      });
    }

    logger.info(
      { disbursementId: row.id, externalId, xenditId: result.id, status: result.status },
      '[disbursement] xendit accepted',
    );
    return prisma.affiliateDisbursement.update({
      where: { id: row.id },
      data: {
        status: DISBURSEMENT_STATUS.PROCESSING,
        provider: 'xendit',
        providerRef: result.id || null,
      },
    });
  }

  // ---- admin approve / reject (MANUAL flow) --------------------------------

  /** Approve a PENDING payout → fire to Xendit. */
  async approveDisbursement(id: string, adminId: string) {
    const row = await prisma.affiliateDisbursement.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Disbursement not found');
    if (row.status !== DISBURSEMENT_STATUS.PENDING) {
      throw new BadRequestException(`Cannot approve a disbursement in status ${row.status}`);
    }
    const approved = await prisma.affiliateDisbursement.update({
      where: { id },
      data: { approvedBy: adminId, approvedAt: new Date() },
    });
    return this.disburseViaXendit(approved);
  }

  /** Reject a PENDING payout → status REJECTED (balance frees automatically). */
  async rejectDisbursement(id: string, adminId: string, reason: string) {
    const row = await prisma.affiliateDisbursement.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Disbursement not found');
    if (row.status !== DISBURSEMENT_STATUS.PENDING) {
      throw new BadRequestException(`Cannot reject a disbursement in status ${row.status}`);
    }
    return prisma.affiliateDisbursement.update({
      where: { id },
      data: {
        status: DISBURSEMENT_STATUS.REJECTED,
        rejectedReason: reason,
        approvedBy: adminId, // reviewer (audit)
      },
    });
  }

  // ---- provider callback (webhook) ----------------------------------------
  //
  // Idempotent by externalId + a status guard. A replayed callback updates 0 rows
  // (the row is already terminal) so it can NEVER double-pay or double-flip.

  /** COMPLETED callback → PAID. Only transitions a non-terminal row. */
  async markPaidByExternalId(externalId: string, providerRef?: string, now: Date = new Date()) {
    const updated = await prisma.affiliateDisbursement.updateMany({
      where: {
        externalId,
        status: { in: [DISBURSEMENT_STATUS.PENDING, DISBURSEMENT_STATUS.PROCESSING] },
      },
      data: {
        status: DISBURSEMENT_STATUS.PAID,
        provider: 'xendit',
        ...(providerRef ? { providerRef } : {}),
        paidAt: now,
      },
    });
    if (updated.count === 0) {
      logger.info({ externalId }, '[disbursement] markPaid noop (unknown/terminal)');
    }
    return updated;
  }

  /** FAILED callback → FAILED (frees balance). Only transitions a non-terminal row. */
  async markFailedByExternalId(externalId: string, reason: string) {
    const updated = await prisma.affiliateDisbursement.updateMany({
      where: {
        externalId,
        status: { in: [DISBURSEMENT_STATUS.PENDING, DISBURSEMENT_STATUS.PROCESSING] },
      },
      data: { status: DISBURSEMENT_STATUS.FAILED, failureReason: reason },
    });
    if (updated.count === 0) {
      logger.info({ externalId }, '[disbursement] markFailed noop (unknown/terminal)');
    }
    return updated;
  }

  // ---- legacy by-id helpers (kept for existing callers / tests) ------------

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

  // ---- listing ------------------------------------------------------------

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

  // ---- KYC -----------------------------------------------------------------

  async submitKyc(
    memberId: string,
    input: { idNumber: string; idCardUrl: string; selfieUrl?: string },
  ) {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: { kycStatus: true },
    });
    if (!member) throw new NotFoundException('Member not found');
    if (member.kycStatus === 'PENDING') throw new BadRequestException('KYC sedang ditinjau');
    if (member.kycStatus === 'APPROVED') throw new BadRequestException('KYC sudah disetujui');
    return prisma.member.update({
      where: { id: memberId },
      data: {
        kycStatus: 'PENDING',
        kycIdNumber: input.idNumber,
        kycIdCardUrl: input.idCardUrl,
        kycSelfieUrl: input.selfieUrl ?? null,
        kycSubmittedAt: new Date(),
        kycReviewedAt: null,
        kycReviewedBy: null,
        kycRejectedReason: null,
      },
      select: kycSelect,
    });
  }

  async getKyc(memberId: string) {
    const member = await prisma.member.findUnique({ where: { id: memberId }, select: kycSelect });
    if (!member) throw new NotFoundException('Member not found');
    return member;
  }

  async approveKyc(memberId: string, adminId: string) {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: { id: true },
    });
    if (!member) throw new NotFoundException('Member not found');
    return prisma.member.update({
      where: { id: memberId },
      data: {
        kycStatus: 'APPROVED',
        kycReviewedAt: new Date(),
        kycReviewedBy: adminId,
        kycRejectedReason: null,
      },
      select: kycSelect,
    });
  }

  async rejectKyc(memberId: string, adminId: string, reason: string) {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: { id: true },
    });
    if (!member) throw new NotFoundException('Member not found');
    return prisma.member.update({
      where: { id: memberId },
      data: {
        kycStatus: 'REJECTED',
        kycReviewedAt: new Date(),
        kycReviewedBy: adminId,
        kycRejectedReason: reason,
      },
      select: kycSelect,
    });
  }

  // ---- bank account --------------------------------------------------------

  async getBankAccount(memberId: string) {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: { bankCode: true, bankAccountNumber: true, bankAccountName: true },
    });
    if (!member) throw new NotFoundException('Member not found');
    return member;
  }

  async setBankAccount(
    memberId: string,
    input: { bankCode: string; bankAccountNumber: string; bankAccountName: string },
  ) {
    return prisma.member.update({
      where: { id: memberId },
      data: {
        bankCode: input.bankCode,
        bankAccountNumber: input.bankAccountNumber,
        bankAccountName: input.bankAccountName,
      },
      select: { bankCode: true, bankAccountNumber: true, bankAccountName: true },
    });
  }
}

const kycSelect = {
  kycStatus: true,
  kycIdNumber: true,
  kycIdCardUrl: true,
  kycSelfieUrl: true,
  kycSubmittedAt: true,
  kycReviewedAt: true,
  kycRejectedReason: true,
} as const;

/** Monday 00:00 of the week containing `d` (legacy CCarbon::startOfWeek default = Monday). */
function startOfWeekMonday(d: Date): Date {
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = (day + 6) % 7; // days since Monday
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff, 0, 0, 0, 0);
}
