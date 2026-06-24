import { Prisma } from '@prisma/client';
import { prisma } from '@bb/db';
import { BadRequestException, NotFoundException } from '@bb/common/exceptions';
import { logger } from '@bb/common/config/logger';
import { env } from '@bb/common/config/env';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import {
  createDisbursement,
  type CreateDisbursementResult,
} from '@bb/common/services/xendit.client';
import { generateExternalId } from '@bb/common/services/xendit-signature';
import {
  createApplicant,
  generateSdkAccessToken,
  getApplicantByExternalId,
  isSumsubConfigured,
  resetApplicant,
} from '@bb/common/services/sumsub.client';
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

const DAY_MS = 86_400_000;

/** Risk events that revoke an APPROVED KYC and force re-verification. See docs/kyc-rekyc.md. */
export type ReKycReason =
  | 'BANK_CHANGE'
  | 'DORMANT_REACTIVATION'
  | 'LARGE_DISBURSEMENT'
  | 'SUSPICIOUS'
  | 'ADMIN_MANUAL';

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
        kycReviewedAt: true,
        bankCode: true,
        bankAccountNumber: true,
        bankAccountName: true,
      },
    });
    if (!member) throw new NotFoundException('Member not found');
    if (member.kycStatus !== 'APPROVED') {
      throw new BadRequestException(
        member.kycStatus === 'EXPIRED' ? 'KYC perlu diperbarui' : 'KYC belum disetujui',
      );
    }
    if (!member.bankCode || !member.bankAccountNumber || !member.bankAccountName) {
      throw new BadRequestException('Rekening belum diisi');
    }

    // A large payout re-triggers KYC, but only when the last review is stale —
    // a freshly-approved member shouldn't be bounced. netAmount is only known
    // inside the tx, so we abort there and revoke KYC afterwards (see catch).
    const reviewStale =
      !member.kycReviewedAt ||
      Date.now() - member.kycReviewedAt.getTime() > env.rekyc.staleDays * DAY_MS;

    let created;
    try {
      created = await prisma.$transaction(async (tx) => {
      // SECURITY (TOCTOU double-spend): serialize concurrent payout requests for
      // the same member. Without this, two parallel requests both pass the
      // existing-PENDING check and the balance read (READ COMMITTED — neither
      // sees the other's uncommitted HELD row) and both create a PENDING payout,
      // draining the balance Nx. A transaction-scoped advisory lock makes the
      // second request block until the first commits, then see the PENDING row.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memberId}))`;

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

      if (reviewStale && quote.netAmount >= env.rekyc.largeDisbursementIdr) {
        // Abort the tx (no row created, balance untouched); resetKyc runs in the catch.
        throw new ReKycRequiredError(quote.netAmount);
      }

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
    } catch (err) {
      if (err instanceof ReKycRequiredError) {
        await this.resetKyc(memberId, 'LARGE_DISBURSEMENT', { metadata: { amount: err.amount } });
        throw new BadRequestException('Pencairan besar memerlukan verifikasi KYC ulang');
      }
      throw err;
    }

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
    const [updated] = await prisma.$transaction([
      prisma.member.update({
        where: { id: memberId },
        data: {
          kycStatus: 'PENDING',
          kycSource: 'MANUAL',
          kycIdNumber: input.idNumber,
          kycIdCardUrl: input.idCardUrl,
          kycSelfieUrl: input.selfieUrl ?? null,
          kycSubmittedAt: new Date(),
          kycReviewedAt: null,
          kycReviewedBy: null,
          kycRejectedReason: null,
        },
        select: kycSelect,
      }),
      prisma.kycEvent.create({
        data: {
          memberId,
          type: 'SUBMIT',
          fromStatus: member.kycStatus,
          toStatus: 'PENDING',
          actorType: 'SYSTEM',
        },
      }),
    ]);
    return updated;
  }

  async getKyc(memberId: string) {
    const member = await prisma.member.findUnique({ where: { id: memberId }, select: kycSelect });
    if (!member) throw new NotFoundException('Member not found');
    return member;
  }

  // ---- KYC via Sumsub --------------------------------------------------------

  /**
   * Start (or resume) a Sumsub KYC session: ensure an applicant exists for this
   * member (externalUserId = our member UUID) and mint a short-lived SDK access
   * token for the mobile SDK. kycStatus is NOT touched here — webhooks drive the
   * transitions (applicantPending → PENDING, applicantReviewed → APPROVED/REJECTED).
   */
  async createSumsubKycSession(memberId: string) {
    if (!isSumsubConfigured()) {
      throw new BadRequestException('KYC provider not configured');
    }
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: { kycStatus: true, sumsubApplicantId: true },
    });
    if (!member) throw new NotFoundException('Member not found');
    if (member.kycStatus === 'APPROVED') throw new BadRequestException('KYC sudah disetujui');

    let applicantId = member.sumsubApplicantId;
    if (!applicantId) {
      try {
        const applicant = await createApplicant(memberId);
        applicantId = applicant.id;
      } catch (err) {
        // 409 = applicant already exists for this externalUserId (e.g. retry
        // after a crash before we stored the id) — resolve instead of failing.
        if ((err as { status?: number }).status === 409) {
          const existing = await getApplicantByExternalId(memberId);
          applicantId = existing.id;
        } else {
          throw err;
        }
      }
      await prisma.member.update({
        where: { id: memberId },
        data: { sumsubApplicantId: applicantId },
      });
    }

    const accessToken = await generateSdkAccessToken(memberId);
    return { token: accessToken.token, applicantId, kycStatus: member.kycStatus };
  }

  /**
   * Webhook `applicantPending`: documents submitted, review started.
   * Mirrors the manual submitKyc transition. No-op when already APPROVED.
   */
  async markSumsubPending(applicantId: string, externalUserId?: string) {
    const member = await this.findMemberForSumsub(applicantId, externalUserId);
    if (!member) return { handled: false, reason: 'member not found' };
    if (member.kycStatus === 'APPROVED') return { handled: false, reason: 'already approved' };
    await prisma.$transaction([
      prisma.member.update({
        where: { id: member.id },
        data: {
          kycStatus: 'PENDING',
          kycSource: 'SUMSUB',
          sumsubApplicantId: applicantId,
          kycSubmittedAt: new Date(),
          kycReviewedAt: null,
          kycReviewedBy: null,
          kycRejectedReason: null,
        },
      }),
      // Skip the audit row on a webhook replay (already PENDING) to keep it idempotent.
      ...(member.kycStatus === 'PENDING'
        ? []
        : [
            prisma.kycEvent.create({
              data: {
                memberId: member.id,
                type: 'PENDING',
                fromStatus: member.kycStatus,
                toStatus: 'PENDING',
                actorType: 'SUMSUB',
              },
            }),
          ]),
    ]);
    return { handled: true, memberId: member.id, kycStatus: 'PENDING' };
  }

  /**
   * Webhook `applicantReviewed`: GREEN → APPROVED, RED → REJECTED.
   * RED + RETRY can re-submit through the same applicant; RED + FINAL is
   * enforced by Sumsub itself (SDK refuses further attempts). Writes are
   * absolute so webhook replays converge to the same state (idempotent).
   */
  async applySumsubReview(input: {
    applicantId: string;
    externalUserId?: string;
    reviewAnswer: string; // GREEN | RED
    rejectLabels?: string[];
    reviewRejectType?: string; // FINAL | RETRY
  }) {
    const member = await this.findMemberForSumsub(input.applicantId, input.externalUserId);
    if (!member) return { handled: false, reason: 'member not found' };

    const approved = input.reviewAnswer === 'GREEN';
    const rejectedReason = approved
      ? null
      : [input.reviewRejectType, (input.rejectLabels ?? []).join(', ')]
          .filter(Boolean)
          .join(': ') || 'REJECTED';

    const newStatus = approved ? 'APPROVED' : 'REJECTED';
    await prisma.$transaction([
      prisma.member.update({
        where: { id: member.id },
        data: {
          kycStatus: newStatus,
          kycSource: 'SUMSUB',
          sumsubApplicantId: input.applicantId,
          kycReviewedAt: new Date(),
          kycReviewedBy: null, // reviewed by Sumsub, not an admin
          kycRejectedReason: rejectedReason,
        },
      }),
      // Idempotent: a replayed webhook lands on the same status → no duplicate audit row.
      ...(member.kycStatus === newStatus
        ? []
        : [
            prisma.kycEvent.create({
              data: {
                memberId: member.id,
                type: approved ? 'APPROVE' : 'REJECT',
                fromStatus: member.kycStatus,
                toStatus: newStatus,
                actorType: 'SUMSUB',
                metadata: rejectedReason ? { rejectedReason } : undefined,
              },
            }),
          ]),
    ]);
    logger.info(
      { memberId: member.id, applicantId: input.applicantId, reviewAnswer: input.reviewAnswer },
      '[kyc] sumsub review applied',
    );
    return { handled: true, memberId: member.id, kycStatus: approved ? 'APPROVED' : 'REJECTED' };
  }

  /** Resolve the member a Sumsub webhook refers to: applicantId first, then externalUserId (our member UUID). */
  private async findMemberForSumsub(applicantId: string, externalUserId?: string) {
    const byApplicant = await prisma.member.findUnique({
      where: { sumsubApplicantId: applicantId },
      select: { id: true, kycStatus: true },
    });
    if (byApplicant) return byApplicant;
    // externalUserId is our UUID — guard the cast so a foreign id can't blow up the query.
    if (externalUserId && UUID_RE.test(externalUserId)) {
      return prisma.member.findUnique({
        where: { id: externalUserId },
        select: { id: true, kycStatus: true },
      });
    }
    return null;
  }

  // ---- re-KYC --------------------------------------------------------------

  /**
   * Revoke an APPROVED KYC on a risk event (APPROVED → EXPIRED) so the member
   * must re-verify before the next disbursement. No-op unless currently APPROVED.
   * Preserves provenance (kycSource / kycIdNumber); records a kyc_event row.
   * Also resets the Sumsub applicant so a stale GREEN result can't auto-re-approve.
   */
  async resetKyc(
    memberId: string,
    reason: ReKycReason,
    opts: { actorType?: 'SYSTEM' | 'ADMIN'; actorId?: string; metadata?: unknown } = {},
  ): Promise<{ reset: boolean }> {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: { kycStatus: true, sumsubApplicantId: true },
    });
    // Only an APPROVED member can be downgraded. Anything else is a no-op so the
    // call is safe to fire unconditionally from triggers.
    if (!member || member.kycStatus !== 'APPROVED') return { reset: false };

    await prisma.$transaction(async (tx) => {
      await tx.member.update({
        where: { id: memberId },
        data: { kycStatus: 'EXPIRED', kycReviewedAt: null, kycRejectedReason: null },
      });
      await tx.kycEvent.create({
        data: {
          memberId,
          type: 'RESET',
          reason,
          fromStatus: 'APPROVED',
          toStatus: 'EXPIRED',
          actorType: opts.actorType ?? 'SYSTEM',
          actorId: opts.actorId ?? null,
          metadata: (opts.metadata ?? undefined) as Prisma.InputJsonValue,
        },
      });
    });

    // Best-effort: the DB is already EXPIRED (member is blocked) — if Sumsub reset
    // fails we stay fail-safe rather than rolling the revocation back.
    if (member.sumsubApplicantId) {
      try {
        if (isSumsubConfigured()) await resetApplicant(member.sumsubApplicantId);
      } catch (err) {
        logger.error(
          { err, memberId, applicantId: member.sumsubApplicantId },
          '[kyc] sumsub applicant reset failed (member still EXPIRED)',
        );
      }
    }

    logger.info({ memberId, reason }, '[kyc] re-KYC reset applied');
    return { reset: true };
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
    const prev = await prisma.member.findUnique({
      where: { id: memberId },
      select: { bankCode: true, bankAccountNumber: true, kycStatus: true },
    });
    // Reset KYC only when an EXISTING payout account is being CHANGED — first-time
    // setup (prev account null) is normal onboarding and must not revoke KYC.
    const changed =
      !!prev?.bankAccountNumber &&
      (prev.bankCode !== input.bankCode || prev.bankAccountNumber !== input.bankAccountNumber);

    const updated = await prisma.member.update({
      where: { id: memberId },
      data: {
        bankCode: input.bankCode,
        bankAccountNumber: input.bankAccountNumber,
        bankAccountName: input.bankAccountName,
      },
      select: { bankCode: true, bankAccountNumber: true, bankAccountName: true },
    });

    if (changed && prev?.kycStatus === 'APPROVED') {
      await this.resetKyc(memberId, 'BANK_CHANGE', {
        metadata: { from: prev.bankAccountNumber, to: input.bankAccountNumber },
      });
    }
    return updated;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sentinel thrown inside the disbursement tx to abort it and trigger re-KYC in the catch. */
class ReKycRequiredError extends Error {
  constructor(public readonly amount: number) {
    super('re-KYC required');
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
