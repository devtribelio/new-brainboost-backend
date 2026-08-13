import { prisma } from '@bb/db';
import { badRequest, notFound, ERROR_CODES } from '@bb/common/exceptions';
import { assignMemberAffiliateCode } from './utils/code-generator';

export class EnrollmentService {
  /**
   * Auto-enroll member to a program by program code.
   * Idempotent — already-enrolled returns existing record.
   * Auto-assign affiliateCode to member if they don't have one yet.
   */
  async joinByCode(memberId: string, programCode: string) {
    const program = await prisma.affiliateProgram.findUnique({ where: { code: programCode } });
    if (!program) throw notFound(ERROR_CODES.AFFILIATE_PROGRAM_NOT_FOUND, { programCode });
    if (!program.isActive)
      throw badRequest(ERROR_CODES.AFFILIATE_PROGRAM_INACTIVE, { programCode });

    // Ensure member has affiliateCode (legacy: every affiliator has a personal code)
    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) throw notFound(ERROR_CODES.MEMBER_NOT_FOUND);
    if (!member.affiliateCode) {
      await assignMemberAffiliateCode(memberId);
    }

    return prisma.memberAffiliator.upsert({
      where: { memberId_programId: { memberId, programId: program.id } },
      update: { isActive: true, exitState: null, exitAt: null },
      create: {
        memberId,
        programId: program.id,
        isActive: true,
      },
    });
  }

  async listMyEnrollments(memberId: string) {
    return prisma.memberAffiliator.findMany({
      where: { memberId, isActive: true },
      orderBy: { createdAt: 'desc' },
      include: {
        program: { select: { id: true, code: true, name: true, isActive: true, productId: true } },
      },
    });
  }

  async leave(memberId: string, programCode: string) {
    const program = await prisma.affiliateProgram.findUnique({ where: { code: programCode } });
    if (!program) throw notFound(ERROR_CODES.AFFILIATE_PROGRAM_NOT_FOUND, { programCode });

    return prisma.memberAffiliator.update({
      where: { memberId_programId: { memberId, programId: program.id } },
      data: { isActive: false, exitState: 'LEAVE', exitAt: new Date() },
    });
  }
}
