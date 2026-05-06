import { prisma } from '@/config/prisma';
import { NotFoundException } from '@/common/exceptions';

export class MemberService {
  async findById(id: string) {
    const member = await prisma.member.findUnique({
      where: { id },
      include: {
        profile: {
          include: {
            country: true,
            province: true,
            city: true,
            district: true,
          },
        },
      },
    });
    if (!member) throw new NotFoundException('Member not found');
    return member;
  }
}
