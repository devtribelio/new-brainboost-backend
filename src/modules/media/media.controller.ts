import { Readable } from 'node:stream';
import type { Request, Response } from 'express';
import { MediaService } from './media.service';
import { MEDIA_RESOLUTIONS, type MediaResolution } from './dto/media.dto';
import { verifyMediaToken } from './media-token.util';
import { BadRequestException, UnauthorizedException } from '@bb/common/exceptions';
import type { AuthenticatedRequest } from '@bb/common/interfaces/authenticated-request';
import {
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@bb/common/openapi/decorators';
import { env } from '@bb/common/config/env';
import { logger } from '@bb/common/config/logger';

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
  @ApiResponse({
    status: 302,
    description: 'Redirect to a signed Bunny URL (signed mode / Model C)',
    envelope: 'none',
  })
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

    // Model C — hand the client a signed Bunny URL and let it stream from the
    // edge directly. `proxy` mode (Model B) falls through to the byte proxy.
    if (env.media.mode === 'signed') {
      res.redirect(302, this.mediaService.buildSignedUrl(payload.guid));
      return;
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

  @ApiOperation({
    summary: 'Get a signed Bunny MP4 download URL for an audio/video slide',
    description:
      'Decrypts the opaque media token, gates access (enrollment for non-preview), ' +
      'and 302-redirects to a short-lived signed Bunny MP4 URL with a longer TTL ' +
      'tuned for downloads. Rate-limited per member.',
  })
  @ApiQuery({ name: 't', type: 'string', required: true, description: 'Opaque media token.' })
  @ApiQuery({
    name: 'res',
    type: 'string',
    required: false,
    description: 'Rendition: 360p | 480p | 720p. Defaults to the configured resolution.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to a signed Bunny MP4 URL',
    envelope: 'none',
  })
  @ApiResponse({ status: 400, description: 'Missing media token' })
  @ApiResponse({ status: 401, description: 'Invalid/expired token, or auth required' })
  @ApiResponse({ status: 403, description: 'Not enrolled in the course' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  download = async (req: Request, res: Response): Promise<void> => {
    const token = typeof req.query.t === 'string' ? req.query.t : '';
    if (!token) {
      throw new BadRequestException('Missing media token');
    }

    const payload = verifyMediaToken(token);

    if (!payload.isPreview) {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        throw new UnauthorizedException('Authentication required for this media');
      }
      await this.mediaService.assertEnrollment(payload.courseId, user.id);
    }

    const resolution = this.resolveResolution(req.query.res);
    const user = (req as AuthenticatedRequest).user;
    logger.info(
      {
        memberId: user?.id ?? null,
        courseId: payload.courseId,
        guid: payload.guid,
        res: resolution,
        isPreview: payload.isPreview,
      },
      'media: download requested',
    );

    // Content-Disposition on a 302 is honoured by many native downloaders
    // (Android DownloadManager / iOS URLSession / wget). Browsers tend to ignore
    // it and use the Bunny response's headers, so this is a hint, not a hard
    // guarantee — but it lets FE control the saved filename when supported.
    const filename =
      this.sanitizeFilename(req.query.filename) ?? `media-${payload.guid}.mp4`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.redirect(302, this.mediaService.buildDownloadUrl(payload.guid, resolution));
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

  /**
   * Sanitise a client-supplied filename for Content-Disposition. Strips
   * anything outside `[A-Za-z0-9._- ]`, caps at 100 chars, returns null when
   * the result is empty so the caller can fall back to a default.
   */
  private sanitizeFilename(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const cleaned = raw.replace(/[^a-zA-Z0-9._\- ]/g, '').slice(0, 100).trim();
    return cleaned.length > 0 ? cleaned : null;
  }
}
