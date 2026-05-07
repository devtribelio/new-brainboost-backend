import { prisma } from '@/config/prisma';
import { NotFoundException, BadRequestException } from '@/common/exceptions';
import { assignMemberAffiliateCode } from './utils/code-generator';

export class EnrollmentService {
  /**
   * Auto-enroll member to a program by program code.
   * Idempotent — already-enrolled returns existing record.
   * Auto-assign affiliateCode to member if they don't have one yet.
   */
  async joinByCode(memberId: string, programCode: string) {
    const program = await prisma.affiliateProgram.findUnique({ where: { code: programCode } });
    if (!program) throw new NotFoundException(`Program "${programCode}" not found`);
    if (!program.isActive) throw new BadRequestException(`Program "${programCode}" is inactive`);

    // Ensure member has affiliateCode (legacy: every affiliator has a personal code)
    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) throw new NotFoundException('Member not found');
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
    if (!program) throw new NotFoundException(`Program "${programCode}" not found`);

    return prisma.memberAffiliator.update({
      where: { memberId_programId: { memberId, programId: program.id } },
      data: { isActive: false, exitState: 'LEAVE', exitAt: new Date() },
    });
  }
}
