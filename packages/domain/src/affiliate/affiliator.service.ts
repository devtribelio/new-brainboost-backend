import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { NotFoundException, BadRequestException } from '@bb/common/exceptions';
import { assignMemberAffiliateCode } from './utils/code-generator';
import {
  AFFILIATE_BASED,
  COMMISSION_STATUS,
  GROWTH_LEVEL_RATES,
  GROWTH_MAX_DEPTH,
  INACTIVE_RATE,
  type AffiliateBased,
} from './constants';
import { computeAmount, getPerformanceTier } from './utils/compute-amount';
import { walkInviterChain } from './utils/walk-inviter-chain';

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
    const [agg, balanceAgg, pendingAgg, voidedAgg, commisionAgg, recent] = await Promise.all([
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
      // Legacy `commisionSummary` aggregate (merged in). Mirrors CommissionService.summary
      // exactly: PENDING + BALANCE across ALL affiliateBased (incl INACTIVE).
      prisma.affiliateCommission.aggregate({
        where: {
          recipientId: memberId,
          status: { in: [COMMISSION_STATUS.PENDING, COMMISSION_STATUS.BALANCE] },
        },
        _sum: { amount: true, productPrice: true },
        _count: true,
      }),
      prisma.affiliateCommission.findMany({
        where: { recipientId: memberId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    const lifetimeAmount = agg._sum.amount ?? 0;
    const tier = getPerformanceTier(lifetimeAmount);
    const totalCommision = commisionAgg._sum.amount ?? 0;
    const totalTransactionSales = commisionAgg._sum.productPrice ?? 0;

    return {
      lifetimeAmount,
      balance: balanceAgg._sum.amount ?? 0,
      pending: pendingAgg._sum.amount ?? 0,
      voided: voidedAgg._sum.amount ?? 0,
      currency: 'IDR',
      currentTier: tier.tier,
      currentRate: tier.rate,
      schemaType: tier.schemaType,
      // Merged legacy commisionSummary fields (FE legacy CommisionModel — typos preserved).
      totalCommision,
      totalTransactionSales,
      total: totalCommision,
      count: commisionAgg._count,
      recent: recent.map((e) => ({
        id: e.id,
        amount: e.amount,
        status: e.status,
        source: e.source,
        createdAt: e.createdAt,
      })),
    };
  }

  /**
   * Commit affiliate commissions for a successful payment.
   * Idempotent — unique constraint on (paymentId, recipientId, level) prevents duplicates.
   *
   * Walks inviter chain from the buyer, computes priceRecipient per level via
   * `computeAmount(productPrice, voucherAmount, rate)`. Rate depends on the
   * RECIPIENT's `affiliateBased`:
   *  - PERFORMANCE → tier rate (20/30/40 based on lifetimeAmount) — only level 1 paid.
   *  - GROWTH → multitier L1=20 L2=10 L3=5 L4=5, early-stop on PERFORMANCE ancestor.
   *  - INACTIVE → flat 20%, only level 1 paid.
   *
   * `affiliatorId` here = MemberAffiliator.id (program membership), not Member.id.
   * Resolution: lookup MemberAffiliator for each ancestor + program.
   */
  async commitCommissionsForPayment(input: {
    paymentId: string;
    productId: string;
    productPrice: number;
    voucherAmount: number;
    buyerMemberId: string;
    programId?: string | null;
    /** Per-purchase override: the affiliate link used at checkout (supersedes inviter). */
    overrideAffiliatorMemberId?: string | null;
    /** Payment channel / provider: "xendit" | "revenuecat" | "scalev" | "lynkid" | null (legacy/web). */
    channel?: string | null;
  }): Promise<{ committed: number }> {
    // Option B: any product is affiliate-able — `programId` is optional metadata, not a gate.
    // Recipient seed (Model: A permanent + per-purchase link override):
    //  - if this purchase came through a specific affiliate link → that affiliator (override),
    //  - otherwise the buyer's permanent inviter.
    // Level 1 = the seed; GROWTH then walks up the seed's own chain. Skip if neither exists.
    let seedMemberId = input.overrideAffiliatorMemberId ?? null;
    if (!seedMemberId) {
      const buyer = await prisma.member.findUnique({
        where: { id: input.buyerMemberId },
        select: { inviterId: true },
      });
      seedMemberId = buyer?.inviterId ?? null;
    }
    if (!seedMemberId) {
      logger.debug(
        { buyerMemberId: input.buyerMemberId },
        '[affiliate] no link override and no inviter — skip',
      );
      return { committed: 0 };
    }

    const chain = await walkInviterChain(seedMemberId, {
      maxDepth: GROWTH_MAX_DEPTH,
      stopOnPerformance: false,
    });

    let committed = 0;
    for (const node of chain) {
      const level = node.level;
      const rate = await this.resolveRate(node.id, node.affiliateBased, level);
      if (rate === null) continue;

      const amount = computeAmount(input.productPrice, input.voucherAmount, rate);
      if (amount <= 0) continue;

      // MemberAffiliator is program-scoped; only resolvable when a program is attributed.
      const affiliator = input.programId
        ? await prisma.memberAffiliator.findUnique({
            where: { memberId_programId: { memberId: node.id, programId: input.programId } },
            select: { id: true },
          })
        : null;

      const schemaType =
        node.affiliateBased === AFFILIATE_BASED.PERFORMANCE
          ? getPerformanceTier(await this.getLifetimeAmount(node.id)).schemaType
          : null;

      try {
        await prisma.affiliateCommission.create({
          data: {
            recipientId: node.id,
            affiliatorId: affiliator?.id ?? null,
            programId: input.programId,
            productId: input.productId,
            paymentId: input.paymentId,
            buyerMemberId: input.buyerMemberId,
            level,
            affiliateBased: node.affiliateBased,
            schemaType,
            productPrice: input.productPrice,
            voucherAmount: input.voucherAmount,
            commissionRate: rate,
            amount,
            channel: input.channel ?? null,
            status: COMMISSION_STATUS.PENDING,
          },
        });
        committed++;
      } catch (e) {
        // unique (paymentId, recipientId, level) — second emit is a no-op
        const code = (e as { code?: string }).code;
        if (code !== 'P2002') throw e;
        logger.debug(
          { paymentId: input.paymentId, recipientId: node.id, level },
          '[affiliate] commission already exists — skipping',
        );
      }

      // PERFORMANCE / INACTIVE only pays level 1 (legacy parity)
      if (
        node.affiliateBased === AFFILIATE_BASED.PERFORMANCE ||
        node.affiliateBased === AFFILIATE_BASED.INACTIVE
      ) {
        break;
      }
      // GROWTH: stop chain if any ancestor encountered is PERFORMANCE (handled by check on next iter)
      const nextNode = chain[chain.indexOf(node) + 1];
      if (nextNode && nextNode.affiliateBased === AFFILIATE_BASED.PERFORMANCE) {
        break;
      }
    }

    return { committed };
  }

  private async resolveRate(
    memberId: string,
    affiliateBased: string,
    level: number,
  ): Promise<number | null> {
    if (affiliateBased === AFFILIATE_BASED.INACTIVE) {
      return level === 1 ? INACTIVE_RATE : null;
    }
    if (affiliateBased === AFFILIATE_BASED.PERFORMANCE) {
      if (level !== 1) return null;
      const lifetime = await this.getLifetimeAmount(memberId);
      return getPerformanceTier(lifetime).rate;
    }
    if (affiliateBased === AFFILIATE_BASED.GROWTH) {
      if (level > GROWTH_LEVEL_RATES.length) return null;
      return GROWTH_LEVEL_RATES[level - 1];
    }
    return null;
  }

  /**
   * PERFORMANCE-tier commission rate (20/30/40) for a member, derived from
   * lifetime affiliator commission. Used as the flat affiliate-earning preview
   * on product listings (`commisionFixAmount`). Members with no lifetime
   * commission fall to tier 1 (20%), matching the legacy base rate.
   */
  async getPerformanceRate(memberId: string): Promise<number> {
    const lifetime = await this.getLifetimeAmount(memberId);
    return getPerformanceTier(lifetime).rate;
  }

  private async getLifetimeAmount(memberId: string): Promise<number> {
    const agg = await prisma.affiliateCommission.aggregate({
      where: {
        recipientId: memberId,
        status: { not: COMMISSION_STATUS.VOIDED },
        affiliateBased: { not: AFFILIATE_BASED.INACTIVE },
      },
      _sum: { amount: true },
    });
    return agg._sum.amount ?? 0;
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
