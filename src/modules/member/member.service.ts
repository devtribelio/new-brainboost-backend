import { prisma } from '@/config/prisma';
import { NotFoundException } from '@/common/exceptions';
import { buildSystemConfig } from '@/common/services/system-config.service';

interface FindByIdOptions {
  latitude?: number;
  longitude?: number;
  touchActivity?: boolean;
}

export class MemberService {
  async findById(id: string, opts: FindByIdOptions = {}) {
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
    if (!member.isActive) throw new NotFoundException('Member is not active');

    if (opts.touchActivity || opts.latitude !== undefined || opts.longitude !== undefined) {
      await prisma.member.update({
        where: { id },
        data: {
          lastActiveAt: new Date(),
          ...(opts.latitude !== undefined ? { latitude: opts.latitude } : {}),
          ...(opts.longitude !== undefined ? { longitude: opts.longitude } : {}),
        },
      });
    }

    return {
      member,
      memberLogin: {
        id: member.id,
        legacyId: member.legacyId,
        code: member.code,
        email: member.email,
        phone: member.phone,
        fullName: member.fullName,
        avatarUrl: member.avatarUrl,
        coverUrl: member.coverUrl,
      },
      system: buildSystemConfig(),
    };
  }
}
