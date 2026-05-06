import { prisma } from '@/config/prisma';
import { BadRequestException, NotFoundException } from '@/common/exceptions';

export class ReportService {
  async listCategories() {
    return prisma.reportCategory.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
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
    const byId = await prisma.member.findUnique({ where: { id: input }, select: { id: true } });
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
    const byId = await prisma.reportCategory.findUnique({
      where: { id: input },
      select: { id: true },
    });
    return byId?.id ?? null;
  }

  async reportMember(reporterId: string, dto: {
    targetMemberId: string;
    categoryId: string;
    reason?: string;
  }) {
    const targetId = await this.resolveMemberId(dto.targetMemberId);
    if (!targetId) throw new NotFoundException('Target member not found');
    const categoryId = await this.resolveCategoryId(dto.categoryId);
    if (!categoryId) throw new BadRequestException('Invalid category');
    return prisma.memberReport.create({
      data: {
        reporterId,
        targetId,
        categoryId,
        reason: dto.reason ?? null,
      },
    });
  }
}
