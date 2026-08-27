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
 * Slide types a playlist can play.
 *
 * `VideoTemplate` is in the list on purpose: Bunny has no audio-only mode, so an
 * "audio" lesson is a video of a still image, and part of the catalogue is
 * authored as VideoTemplate. Measured on the listening log: 13,279 of 148,644
 * sessions play a VideoTemplate slide. Accepting only AudioTemplate silently hid
 * 9% of what members actually listen to.
 */
export const PLAYABLE_SLIDE_TYPES = ['AudioTemplate', 'VideoTemplate'] as const;

export interface PlayableSlide {
  audioId: string;
  guid: string;
  durationSec: number;
  type: string;
}

function toPlayable(slide: MediaSlide & { id?: unknown }): PlayableSlide | null {
  const type = typeof slide?.type === 'string' ? slide.type : '';
  if (!(PLAYABLE_SLIDE_TYPES as readonly string[]).includes(type)) return null;
  const audioId = typeof slide.id === 'string' && slide.id ? slide.id : null;
  // A slide with no id cannot be referenced by a playlist item at all. Two such
  // slides exist in the catalogue today (both Greeting/ThankYou), so this is not
  // hypothetical — it is just not currently a playable one.
  if (!audioId) return null;
  const d = slide.data ?? {};
  const guid = resolveGuid(d);
  if (!guid) return null;
  return { audioId, guid, durationSec: resolveDurationSec(slide, d), type };
}

/** Every slide of a lesson a playlist could reference, in authoring order. */
export function listPlayableSlides(slidesData: unknown): PlayableSlide[] {
  if (!Array.isArray(slidesData)) return [];
  return slidesData
    .map((raw) => toPlayable(raw as MediaSlide & { id?: unknown }))
    .filter((s): s is PlayableSlide => s !== null);
}

/**
 * The slide a playlist item points at, keyed by the same `audioId` the listening
 * log uses, or `null` when it is gone — the lesson was re-saved without it, or its
 * id changed. Seven ids in the log already resolve to nothing, so a dangling
 * reference is a real state, not a theoretical one; callers drop the row rather
 * than render a dead entry.
 */
export function findPlayableAudio(slidesData: unknown, audioId: string): PlayableSlide | null {
  return listPlayableSlides(slidesData).find((s) => s.audioId === audioId) ?? null;
}
