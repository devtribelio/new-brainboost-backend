import { prisma } from '@/config/prisma';
import { NotFoundException, BadRequestException } from '@/common/exceptions';
import { assignMemberAffiliateCode } from './utils/code-generator';
import { AFFILIATE_BASED, COMMISSION_STATUS, type AffiliateBased } from './constants';
import { getPerformanceTier } from './utils/compute-amount';

export class AffiliatorService {
  /**
   * Get my affiliator profile. Auto-generate `affiliateCode` if missing
   * (legacy convention: every member can be an affiliator).
   */
  async getMe(memberId: string) {
    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) throw new NotFoundException('Member not found');

    if (!member.affiliateCode) {
      const code = await assignMemberAffiliateCode(memberId);
      return {
        memberId: member.id,
        affiliateCode: code,
        affiliateBased: member.affiliateBased,
        inviterId: member.inviterId,
      };
    }

    return {
      memberId: member.id,
      affiliateCode: member.affiliateCode,
      affiliateBased: member.affiliateBased,
      inviterId: member.inviterId,
    };
  }

  /**
   * Set my affiliate mode. New members default to PERFORMANCE.
   * GROWTH is legacy-only — kept for migrating existing users.
   */
  async setMode(memberId: string, mode: AffiliateBased) {
    if (!Object.values(AFFILIATE_BASED).includes(mode)) {
      throw new BadRequestException(`Invalid affiliateBased: ${mode}`);
    }
    return prisma.member.update({
      where: { id: memberId },
      data: { affiliateBased: mode },
      select: { id: true, affiliateBased: true },
    });
  }

  /**
   * Aggregate summary for affiliator dashboard.
   * `lifetimeAmount` excludes VOIDED + INACTIVE (matches legacy
   * `getPerformanceSchemaPercent` query semantics).
   */
  async getSummary(memberId: string) {
    const [agg, balanceAgg, pendingAgg, voidedAgg] = await Promise.all([
      prisma.affiliateCommission.aggregate({
        where: {
          recipientId: memberId,
          status: { not: COMMISSION_STATUS.VOIDED },
          affiliateBased: { not: AFFILIATE_BASED.INACTIVE },
        },
        _sum: { amount: true },
      }),
      prisma.affiliateCommission.aggregate({
        where: { recipientId: memberId, status: COMMISSION_STATUS.BALANCE },
        _sum: { amount: true },
      }),
      prisma.affiliateCommission.aggregate({
        where: { recipientId: memberId, status: COMMISSION_STATUS.PENDING },
        _sum: { amount: true },
      }),
      prisma.affiliateCommission.aggregate({
        where: { recipientId: memberId, status: COMMISSION_STATUS.VOIDED },
        _sum: { amount: true },
      }),
    ]);

    const lifetimeAmount = agg._sum.amount ?? 0;
    const tier = getPerformanceTier(lifetimeAmount);

    return {
      lifetimeAmount,
      balance: balanceAgg._sum.amount ?? 0,
      pending: pendingAgg._sum.amount ?? 0,
      voided: voidedAgg._sum.amount ?? 0,
      currency: 'IDR',
      currentTier: tier.tier,
      currentRate: tier.rate,
      schemaType: tier.schemaType,
    };
  }

  async listCommissions(memberId: string, filter: { status?: string; from?: Date; to?: Date }, page: number, perPage: number) {
    const where: Record<string, unknown> = { recipientId: memberId };
    if (filter.status) where.status = filter.status;
    if (filter.from || filter.to) {
      where.createdAt = {
        ...(filter.from ? { gte: filter.from } : {}),
        ...(filter.to ? { lte: filter.to } : {}),
      };
    }

    const [rows, total] = await Promise.all([
      prisma.affiliateCommission.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
        include: { program: { select: { code: true, name: true } } },
      }),
      prisma.affiliateCommission.count({ where }),
    ]);

    return { rows, total };
  }
}
