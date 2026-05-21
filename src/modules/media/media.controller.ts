import { Readable } from 'node:stream';
import type { Request, Response } from 'express';
import { MediaService } from './media.service';
import { MEDIA_RESOLUTIONS, type MediaResolution } from './dto/media.dto';
import { verifyMediaToken } from './media-token.util';
import { BadRequestException, UnauthorizedException } from '@/common/exceptions';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';
import {
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@/common/openapi/decorators';
import { env } from '@/config/env';
import { logger } from '@/config/logger';

/** Upstream response headers relayed verbatim to the client. */
const RELAYED_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
] as const;

@ApiTags('Media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @ApiOperation({
    summary: 'Stream a Bunny Stream MP4 rendition via the backend proxy',
    description:
      'Decrypts the opaque media token, gates access (enrollment for non-preview), ' +
      'and pipes the upstream MP4 bytes. Supports HTTP range requests (player seeking) ' +
      'and HEAD probes. Returns binary `video/mp4`, not the JSON envelope.',
  })
  @ApiQuery({
    name: 't',
    type: 'string',
    required: true,
    description: 'Opaque media stream token.',
  })
  @ApiQuery({
    name: 'res',
    type: 'string',
    required: false,
    description: 'Rendition: 360p | 480p | 720p. Defaults to the configured resolution.',
  })
  @ApiResponse({
    status: 200,
    description: 'Binary media stream (video/mp4)',
    envelope: 'none',
  })
  @ApiResponse({ status: 206, description: 'Partial content (range request)', envelope: 'none' })
  @ApiResponse({ status: 400, description: 'Missing media token' })
  @ApiResponse({ status: 401, description: 'Invalid/expired token, or auth required' })
  @ApiResponse({ status: 403, description: 'Not enrolled in the course' })
  @ApiResponse({ status: 404, description: 'Media not found' })
  stream = async (req: Request, res: Response): Promise<void> => {
    const token = typeof req.query.t === 'string' ? req.query.t : '';
    if (!token) {
      throw new BadRequestException('Missing media token');
    }

    // Throws UnauthorizedException on a bad/expired/tampered token.
    const payload = verifyMediaToken(token);

    if (!payload.isPreview) {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        throw new UnauthorizedException('Authentication required for this media');
      }
      await this.mediaService.assertEnrollment(payload.courseId, user.id);
    }

    const resolution = this.resolveResolution(req.query.res);
    const isHead = req.method === 'HEAD';

    // Abort the upstream fetch as soon as the client goes away.
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.on('close', abort);
    res.on('close', abort);

    let upstream: globalThis.Response;
    try {
      upstream = await this.mediaService.fetchUpstream(
        payload.guid,
        resolution,
        typeof req.headers.range === 'string' ? req.headers.range : undefined,
        controller.signal,
      );
    } catch (err) {
      // Client disconnect aborts the fetch — nothing to relay, just bail.
      if (controller.signal.aborted) return;
      logger.error({ err }, 'media: upstream fetch failed');
      if (!res.headersSent) res.sendStatus(502);
      return;
    }

    // Never leak that the asset lives on Bunny — collapse 403/404 to a plain 404.
    if (upstream.status === 403 || upstream.status === 404) {
      logger.warn({ status: upstream.status }, 'media: upstream returned not-found/forbidden');
      if (!res.headersSent) res.sendStatus(404);
      return;
    }

    res.status(upstream.status);
    for (const name of RELAYED_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) res.setHeader(name, value);
    }

    if (isHead || !upstream.body) {
      res.end();
      return;
    }

    const body = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    // A client disconnect aborts the upstream fetch, which surfaces here as a
    // stream 'error'. Without a listener that would crash the process.
    body.on('error', (err) => {
      if (!controller.signal.aborted) {
        logger.error({ err }, 'media: upstream stream error');
      }
      res.destroy();
    });
    body.pipe(res);
  };

  /** Validate the `res` query param; fall back to the configured default. */
  private resolveResolution(raw: unknown): MediaResolution {
    if (typeof raw === 'string' && (MEDIA_RESOLUTIONS as readonly string[]).includes(raw)) {
      return raw as MediaResolution;
    }
    if (typeof raw === 'string' && raw !== '') {
      throw new BadRequestException('Invalid resolution — expected 360p | 480p | 720p');
    }
    return env.media.defaultResolution as MediaResolution;
  }
}
