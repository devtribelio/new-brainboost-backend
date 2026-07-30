import { prisma } from '@bb/db';
import { badRequest, notFound, ERROR_CODES } from '@bb/common/exceptions';
import { assertUuid } from '@bb/common/utils/uuid.util';

export class ReportService {
  async listCategories(opts: { isActive?: boolean; orderBy?: 'name' | 'createdAt' } = {}) {
    const where = opts.isActive === undefined ? {} : { isActive: opts.isActive };
    return prisma.reportCategory.findMany({
      where,
      orderBy: { [opts.orderBy ?? 'name']: 'asc' },
    });
  }

  private async resolveMemberId(input: string): Promise<string | null> {
    const legacyId = Number.parseInt(input, 10);
    if (Number.isFinite(legacyId) && input === String(legacyId)) {
      const byLegacy = await prisma.member.findUnique({
        where: { legacyId },
        select: { id: true },
      });
      if (byLegacy) return byLegacy.id;
    }
    assertUuid(input);
    const byId = await prisma.member.findUnique({ where: { id: input }, select: { id: true } });
    return byId?.id ?? null;
  }

  private async resolvePostId(input: string): Promise<string | null> {
    const legacyId = Number.parseInt(input, 10);
    if (Number.isFinite(legacyId) && input === String(legacyId)) {
      const byLegacy = await prisma.post.findUnique({ where: { legacyId }, select: { id: true } });
      if (byLegacy) return byLegacy.id;
    }
    assertUuid(input);
    const byId = await prisma.post.findUnique({ where: { id: input }, select: { id: true } });
    return byId?.id ?? null;
  }

  private async resolveCategoryId(input: string): Promise<string | null> {
    const legacyId = Number.parseInt(input, 10);
    if (Number.isFinite(legacyId) && input === String(legacyId)) {
      const byLegacy = await prisma.reportCategory.findUnique({
        where: { legacyId },
        select: { id: true },
      });
      if (byLegacy) return byLegacy.id;
    }
    assertUuid(input);
    const byId = await prisma.reportCategory.findUnique({
      where: { id: input },
      select: { id: true },
    });
    return byId?.id ?? null;
  }

  async reportMember(
    reporterId: string,
    dto: {
      targetMemberId: string;
      categoryId: string;
      networkId?: string;
      reason?: string;
    },
  ) {
    const targetId = await this.resolveMemberId(dto.targetMemberId);
    if (!targetId) throw notFound(ERROR_CODES.TARGET_MEMBER_NOT_FOUND);
    if (targetId === reporterId) throw badRequest(ERROR_CODES.REPORT_SELF_FORBIDDEN);

    const categoryId = await this.resolveCategoryId(dto.categoryId);
    if (!categoryId) throw badRequest(ERROR_CODES.REPORT_CATEGORY_INVALID);

    const cat = await prisma.reportCategory.findUnique({
      where: { id: categoryId },
      select: { id: true, name: true, legacyId: true },
    });

    const created = await prisma.memberReport.create({
      data: {
        reporterId,
        targetId,
        categoryId,
        networkId: dto.networkId ?? null,
        reason: dto.reason ?? null,
        reportStatus: 'REPORTED',
      },
    });
    return {
      memberReportMemberId: created.id,
      memberReportMemberCategoryId: cat?.legacyId ?? cat?.id ?? null,
      memberReportMemberCategory: cat?.name ?? null,
      networkId: dto.networkId ?? null,
      memberId: reporterId,
      memberToId: targetId,
      reportStatus: created.reportStatus,
    };
  }

  async reportPost(
    reporterId: string,
    dto: {
      postId: string;
      categoryId: string;
      networkId?: string;
      reason?: string;
    },
  ) {
    const postId = await this.resolvePostId(dto.postId);
    if (!postId) throw notFound(ERROR_CODES.POST_NOT_FOUND);

    const categoryId = await this.resolveCategoryId(dto.categoryId);
    if (!categoryId) throw badRequest(ERROR_CODES.REPORT_CATEGORY_INVALID);

    const created = await prisma.postReport.create({
      data: {
        postId,
        reporterId,
        categoryId,
        networkId: dto.networkId ?? null,
        reason: dto.reason ?? null,
        reportStatus: 'REPORTED',
      },
    });
    return {
      postReportId: created.id,
      postId,
      categoryId,
      networkId: dto.networkId ?? null,
      reportStatus: created.reportStatus,
    };
  }
}
