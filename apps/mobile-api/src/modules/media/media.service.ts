import { forbidden, ERROR_CODES, ForbiddenException } from '@bb/common/exceptions';
import { env } from '@bb/common/config/env';
import { prisma } from '@bb/db';
import { S3StorageService, s3StorageService } from '@bb/common/services/s3-storage.service';
import { hasActiveEnrollment } from '@bb/domain/commerce/enrollment';
import type { MediaResolution } from './dto/media.dto';
import { signBunnyHlsUrl, signBunnyMp4Url } from './bunny-sign.util';
import { renderSingleSegmentPlaylist } from './audio-playlist.util';
import { signAudioPlaylistToken, type MediaTokenPayload } from './media-token.util';

/** The subset of `media_audio_sources` the playlist needs. */
export interface AudioSource {
  guid: string;
  audioKey: string;
  durationSec: number;
}

/**
 * Media proxy service.
 *
 * Streams Bunny Stream MP4 bytes through the backend so the raw Bunny `guid` /
 * library id never reach the mobile client. Enrollment gating for non-preview
 * media lives here; the controller stays thin.
 */
export class MediaService {
  constructor(private readonly storage: S3StorageService = s3StorageService) {}

  /**
   * Throw `ForbiddenException` unless `memberId` holds a live enrollment in
   * `courseId`. Used to gate non-preview media — preview media skips this
   * entirely. A refunded enrollment is kept as a cancelled row, so this must
   * check the flag, not mere row existence.
   */
  async assertEnrollment(courseId: string, memberId: string): Promise<void> {
    if (!(await hasActiveEnrollment(memberId, courseId))) {
      throw forbidden(ERROR_CODES.COURSE_NOT_ENROLLED);
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

  /**
   * Build a signed, short-lived HLS URL for direct-from-edge playback (Model C).
   * The Bunny library has Token Authentication on — the signature is what makes
   * the URL playable, so the raw `guid` in it is harmless.
   */
  buildSignedUrl(guid: string): string {
    return signBunnyHlsUrl(guid);
  }

  /**
   * Build a signed HLS URL together with the exact expiry embedded in it.
   *
   * Same signature as `buildSignedUrl`, but the caller gets the `expiresAt` back
   * so it can be handed to the client — a native offline downloader
   * (`AVAssetDownloadTask` / ExoPlayer `DownloadManager`) cannot swap the URL of
   * an in-flight task, so the app needs to know the deadline up front rather
   * than discovering it as a mid-download `403`.
   *
   * `forDownload` picks the longer `MEDIA_DOWNLOAD_TTL_SECONDS` instead of the
   * streaming TTL: fetching every segment of a one-hour lesson takes far longer
   * than starting playback, but a stream has no reason to hand out a URL that
   * stays valid (and shareable) for a day.
   */
  buildHlsUrl(guid: string, opts: { forDownload?: boolean } = {}): {
    url: string;
    expiresAt: number;
  } {
    const ttlSeconds = opts.forDownload
      ? env.media.downloadTtlSeconds
      : env.media.signedUrlTtlSeconds;
    // Pin the expiry so the returned value and the one signed into the URL are
    // the same number, not two `Date.now()` reads a millisecond apart.
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    return { url: signBunnyHlsUrl(guid, { expiresAt }), expiresAt };
  }

  /**
   * Build a signed, long-lived MP4 URL for offline downloads. Same Bunny token
   * scheme as the HLS variant but for a single rendition file and with the
   * download TTL (`MEDIA_DOWNLOAD_TTL_SECONDS`).
   */
  buildDownloadUrl(guid: string, res: MediaResolution): string {
    return signBunnyMp4Url(guid, res);
  }

  /**
   * The single-file audio source for a guid, or null when the asset is still
   * served from Bunny. Inactive rows read as null on purpose: flipping
   * `is_active` is the per-asset rollback, and it must need no deploy.
   */
  async findAudioSource(guid: string): Promise<AudioSource | null> {
    const row = await prisma.mediaAudioSource.findUnique({
      where: { guid },
      select: { guid: true, audioKey: true, durationSec: true, isActive: true },
    });
    if (!row || !row.isActive) return null;
    return { guid: row.guid, audioKey: row.audioKey, durationSec: row.durationSec };
  }

  /** Stream vs download TTL, the same rule the Bunny path uses. */
  private ttlFor(forDownload: boolean): number {
    return forDownload ? env.media.downloadTtlSeconds : env.media.signedUrlTtlSeconds;
  }

  /**
   * URL of the backend-generated single-segment playlist for an asset that has
   * moved to our own storage. Same shape as `buildHlsUrl` so the controller can
   * answer `/media/hls` identically whichever source the guid lives on.
   *
   * The URL carries a dedicated audio-playlist token rather than the media
   * token: the app fetches this URL with no bearer (native downloaders), so the
   * token IS the credential, and it is minted only after the access gate on
   * `/media/hls` passed. Its TTL equals the segment URL TTL the playlist will
   * carry, so a token can never lead to a URL that has already expired.
   */
  buildAudioPlaylistUrl(
    payload: MediaTokenPayload,
    opts: { forDownload?: boolean } = {},
  ): { url: string; expiresAt: number } {
    const forDownload = opts.forDownload === true;
    const ttlSeconds = this.ttlFor(forDownload);
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    const token = signAudioPlaylistToken(
      { guid: payload.guid, courseId: payload.courseId, isPreview: payload.isPreview, forDownload },
      ttlSeconds,
    );
    const base = env.baseUrl.replace(/\/$/, '');
    return { url: `${base}/api/member/media/audio-playlist?t=${encodeURIComponent(token)}`, expiresAt };
  }

  /**
   * The playlist body: one `.aac` segment behind a short-lived signed URL.
   *
   * The segment URL is minted per request, never stored — that is what keeps
   * the playlist itself uncacheable (`no-store` at the controller) and the
   * object private. Today the signer is an S3 presigned GET; when the CDN
   * behaviour ships, this is the one line that switches to a CloudFront
   * signature. The app never sees the difference.
   */
  async buildAudioPlaylist(
    source: AudioSource,
    opts: { forDownload?: boolean } = {},
  ): Promise<string> {
    const segmentUrl = await this.storage.getPresignedGetUrl(
      source.audioKey,
      this.ttlFor(opts.forDownload === true),
    );
    return renderSingleSegmentPlaylist({ segmentUrl, durationSec: source.durationSec });
  }

  /**
   * Presign a `private/*` lesson document for a single short-lived read. Unlike
   * the Bunny helpers above this hits S3, so it is async. The key comes from a
   * decrypted document token — it is never client-supplied.
   */
  async buildDocumentUrl(key: string): Promise<string> {
    return this.storage.getPresignedGetUrl(key, env.s3.presignExpires);
  }
}
