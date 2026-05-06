import { prisma } from '@/config/prisma';
import { NotFoundException } from '@/common/exceptions';

export class MemberService {
  async findById(id: string) {
    const member = await prisma.member.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        username: true,
        phone: true,
        fullName: true,
        avatarUrl: true,
        bio: true,
        isVerified: true,
        createdAt: true,
      },
    });
    if (!member) throw new NotFoundException('Member not found');
    return member;
  }
}
