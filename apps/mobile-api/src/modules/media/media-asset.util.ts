import { signMediaToken } from '@/modules/media/media-token.util';
import { env } from '@bb/common/config/env';

/**
 * Bunny asset plumbing shared by every response that exposes lesson media.
 *
 * Extracted from `product.serializer` when the playlist module needed the same
 * three things (find the guid, read the duration, mint the opaque URL). Keeping
 * one copy is the point: a second guid parser would drift from this one the
 * first time a new slide shape lands, and the two would then disagree about
 * which asset a lesson plays.
 */

/** Minimal structural view of a slide — the full `RawSlide` lives in the serializer. */
export interface MediaSlideData {
  /** Lean shape (post-normalization) — Bunny guid directly on `data`. */
  guid?: unknown;
  /** Lean shape — real per-slide duration in seconds. */
  durationSec?: unknown;
  audio?: Record<string, unknown>;
  video?: Record<string, unknown>;
  /** Iframe-HTML shape — VideoTemplate Bunny embed wrapped in `data.url`. */
  url?: unknown;
}

export interface MediaSlide {
  type?: unknown;
  duration?: unknown;
  data?: MediaSlideData;
}

/**
 * Pull the Bunny `libraryId` + `guid` out of a VideoTemplate `data.url` blob,
 * which wraps an `<iframe src="https://iframe.mediadelivery.net/embed/{lib}/{guid}?...">`.
 * Returns `null` for non-Bunny URLs (e.g. YouTube / external embeds) so they
 * pass through untouched.
 */
export function parseBunnyEmbed(html: string): { libraryId: string; guid: string } | null {
  const m = /iframe\.mediadelivery\.net\/embed\/(\d+)\/([0-9a-fA-F-]{36})/.exec(html);
  if (!m) return null;
  return { libraryId: m[1], guid: m[2] };
}

/**
 * Resolve the Bunny `guid` from either slide shape:
 *   - lean (post-normalization):   `data.guid`
 *   - raw audio blob:              `data.audio.guid`
 *   - raw structured video:        `data.video.guid`
 *   - raw iframe video:            parsed out of `data.url`
 */
export function resolveGuid(d: MediaSlideData): string | null {
  if (typeof d.guid === 'string') return d.guid;
  if (d.audio && typeof d.audio.guid === 'string') return d.audio.guid;
  if (d.video && typeof d.video.guid === 'string') return d.video.guid;
  if (typeof d.url === 'string') return parseBunnyEmbed(d.url)?.guid ?? null;
  return null;
}

/**
 * Real per-slide duration in seconds. Prefers the lean `data.durationSec`, then the
 * raw Bunny blob `length` (audio/video), then the legacy slide-level `duration`.
 * `Lesson.duration` is the sum of these across the lesson's media slides.
 */
export function resolveDurationSec(slide: MediaSlide, d: MediaSlideData): number {
  const raw = d.durationSec ?? d.audio?.length ?? d.video?.length ?? slide.duration;
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Build the opaque media-proxy URL that replaces the raw Bunny `guid` /
 * `videoLibraryId` in client-facing responses.
 */
export function buildStreamUrl(guid: string, courseId: string, isPreview: boolean): string {
  const token = signMediaToken({ guid, courseId, isPreview });
  return `/api/member/media/stream?t=${token}`;
}

/**
 * Build a long-lived signed download URL for the same Bunny asset. The opaque
 * token carries the longer download TTL so it does not expire before a slow
 * offline download finishes; the proxy endpoint then 302-redirects to a signed
 * Bunny MP4 URL.
 */
export function buildDownloadUrl(guid: string, courseId: string, isPreview: boolean): string {
  const token = signMediaToken({ guid, courseId, isPreview }, env.media.downloadTtlSeconds);
  return `/api/member/media/download?t=${token}`;
}

/**
 * First playable audio of a lesson: the guid + duration of its first
 * `AudioTemplate` slide, or `null` when the lesson has none.
 *
 * A lesson can hold several slides (audio, video, documents); a playlist item
 * plays exactly one thing, and "audio" is what a playlist is for — so a lesson
 * whose slides carry no audio is not playable from a playlist and is filtered
 * out rather than silently rendered as a dead row.
 */
export function findLessonAudio(slidesData: unknown): { guid: string; durationSec: number } | null {
  if (!Array.isArray(slidesData)) return null;
  for (const raw of slidesData) {
    const slide = raw as MediaSlide;
    if (slide?.type !== 'AudioTemplate') continue;
    const d = slide.data ?? {};
    const guid = resolveGuid(d);
    if (guid) return { guid, durationSec: resolveDurationSec(slide, d) };
  }
  return null;
}
