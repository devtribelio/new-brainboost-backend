import { prisma } from '@bb/db';
import { forbidden, notFound, ERROR_CODES } from '@bb/common/exceptions';
import { S3StorageService, s3StorageService } from '@bb/common/services/s3-storage.service';
import { env } from '@bb/common/config/env';
import { hasActiveEnrollment } from '@bb/domain/commerce/enrollment';
import type { BonusAccessUrlDto } from './bonus.dto';

export class BonusService {
  constructor(private readonly storage: S3StorageService = s3StorageService) {}

  /**
   * Mint a short-lived presigned GET URL for a bonus PDF, gated on enrollment —
   * the SAME gate the media module uses (`MediaService.assertEnrollment`), so
   * access is enforced server-side, not by hiding the button. Throws:
   *   - 404 if the bonus is missing or inactive,
   *   - 403 if the member is not enrolled in the owning course.
   */
  async getAccessUrl(memberId: string, bonusId: string): Promise<BonusAccessUrlDto> {
    const bonus = await prisma.courseBonus.findFirst({
      where: { id: bonusId, isActive: true },
      select: { courseId: true, fileKey: true },
    });
    if (!bonus) throw notFound(ERROR_CODES.BONUS_NOT_FOUND);

    if (!(await hasActiveEnrollment(memberId, bonus.courseId))) {
      throw forbidden(ERROR_CODES.COURSE_NOT_ENROLLED);
    }

    const expiresInSec = env.s3.presignExpires;
    const url = await this.storage.getPresignedGetUrl(bonus.fileKey, expiresInSec);
    return { url, expiresInSec };
  }
}
