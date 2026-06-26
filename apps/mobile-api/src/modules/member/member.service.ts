import { prisma } from '@bb/db';
import { NotFoundException } from '@bb/common/exceptions';
import { buildSystemConfig } from '@bb/common/services/system-config.service';
import { env } from '@bb/common/config/env';
import { DisbursementService } from '@bb/domain/affiliate/disbursement.service';

interface FindByIdOptions {
  latitude?: number;
  longitude?: number;
  touchActivity?: boolean;
}

const DAY_MS = 86_400_000;

export class MemberService {
  constructor(private readonly disbursementService = new DisbursementService()) {}

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

    // Re-KYC on dormant reactivation: this is the app-resume chokepoint (it already
    // bumps lastActiveAt). member.lastActiveAt still holds the PREVIOUS session's
    // activity here (the update below overwrites it), so the gap is the idle span.
    // resetKyc is a no-op unless currently APPROVED, so the guard stays cheap.
    if (member.kycStatus === 'APPROVED' && member.lastActiveAt) {
      const idleMs = Date.now() - member.lastActiveAt.getTime();
      if (idleMs > env.rekyc.dormantDays * DAY_MS) {
        await this.disbursementService.resetKyc(id, 'DORMANT_REACTIVATION', {
          metadata: { dormantDays: Math.floor(idleMs / DAY_MS) },
        });
      }
    }

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
