import { ForbiddenException } from '@/common/exceptions';
import { env } from '@/config/env';
import { prisma } from '@/config/prisma';
import type { MediaResolution } from './dto/media.dto';

/**
 * Media proxy service.
 *
 * Streams Bunny Stream MP4 bytes through the backend so the raw Bunny `guid` /
 * library id never reach the mobile client. Enrollment gating for non-preview
 * media lives here; the controller stays thin.
 */
export class MediaService {
  /**
   * Throw `ForbiddenException` unless `memberId` is enrolled in `courseId`.
   * Used to gate non-preview media — preview media skips this entirely.
   */
  async assertEnrollment(courseId: string, memberId: string): Promise<void> {
    const enrollment = await prisma.courseEnrollment.findUnique({
      where: { memberId_courseId: { memberId, courseId } },
      select: { id: true },
    });
    if (!enrollment) {
      throw new ForbiddenException('Not enrolled in this course');
    }
  }

  /**
   * Fetch the rendition MP4 from the Bunny Stream pull zone.
   *
   * The `Referer` header is mandatory — the pull zone is configured to block
   * empty-referer requests. `range` is forwarded verbatim so the player can do
   * byte-range seeking (yields a 206 from Bunny). `signal` lets the caller
   * abort the upstream fetch when the client disconnects.
   */
  async fetchUpstream(
    guid: string,
    res: MediaResolution,
    range?: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = `https://${env.bunny.streamCdnHost}/${guid}/play_${res}.mp4`;
    return fetch(url, {
      headers: {
        Referer: env.bunny.referer,
        ...(range ? { Range: range } : {}),
      },
      signal,
    });
  }
}
