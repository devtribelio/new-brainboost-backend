import { prisma } from '@bb/db';
import { notFound, ERROR_CODES } from '@bb/common/exceptions';
import { S3StorageService, s3StorageService } from '@bb/common/services/s3-storage.service';
import { EntitlementService } from '@bb/domain/subscription/entitlement.service';
import { env } from '@bb/common/config/env';
import type { BonusAccessUrlDto } from './bonus.dto';

export class BonusService {
  constructor(
    private readonly storage: S3StorageService = s3StorageService,
    private readonly entitlement: EntitlementService = new EntitlementService(),
  ) {}

  /**
   * Mint a short-lived presigned GET URL for a bonus PDF, gated on course access.
   * The gate (`assertCourseAccess`) passes on a valid enrollment OR an active
   * subscription covering the course — the SAME gate the media module uses, so
   * access is enforced server-side (not by hiding the button). Throws:
   *   - 404 if the bonus is missing or inactive,
   *   - 403 (ForbiddenException from the gate) if the member has no access.
   */
  async getAccessUrl(memberId: string, bonusId: string): Promise<BonusAccessUrlDto> {
    const bonus = await prisma.courseBonus.findFirst({
      where: { id: bonusId, isActive: true },
      select: { courseId: true, fileKey: true },
    });
    if (!bonus) throw notFound(ERROR_CODES.BONUS_NOT_FOUND);

    await this.entitlement.assertCourseAccess(memberId, bonus.courseId);

    const expiresInSec = env.s3.presignExpires;
    const url = await this.storage.getPresignedGetUrl(bonus.fileKey, expiresInSec);
    return { url, expiresInSec };
  }
}
