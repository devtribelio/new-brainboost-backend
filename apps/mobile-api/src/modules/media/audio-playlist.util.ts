/**
 * Render an HLS VOD media playlist from a short list of segments.
 *
 * Why a playlist at all, rather than handing the app the file URL: the mobile
 * app already in the stores only knows how to download "every segment listed
 * in the playlist" (`hls_download_service.dart`), and iOS hands the URL to
 * `AVAssetDownloadURLSession`. A playlist with one or a few segments is valid
 * HLS, so both platforms fetch a handful of files with zero client change.
 *
 * Why a handful and not one: the app's downloader fetches segments in batches
 * (12 in 3.3.3, 8 in 3.4.0) and schedules the next batch from a Dart loop that
 * MIUI freezes in the background; it also draws progress as segments done /
 * total. Started at 12 parts (one batch) on the theory that MIUI kills the app
 * between batches; a staging test on a POCO (1 Mbit/s, screen locked) finished 119
 * parts / 10 batches fine, so the default is 120 (2026-09-22): ~1% progress steps
 * and ~0.5 MB retries. Bunny's ~900 x 4 s segments (~75 batches) is what failed.
 *
 * Constraints that shape the output:
 *  - `EXT-X-TARGETDURATION` must be >= the longest rounded segment duration.
 *  - Segment URIs are absolute (S3 presigned or CloudFront signed); the app
 *    resolves them against the playlist URL and keeps the extension so
 *    ExoPlayer picks the right extractor. Query strings are not part of the
 *    path, so signatures never leak into the local filename.
 *  - A single `.aac` (ADTS) segment is valid without `EXT-X-MAP`; the split
 *    variant uses MPEG-TS parts produced by ffmpeg's hls muxer.
 */
export interface PlaylistSegment {
  url: string;
  durationSec: number;
}

export function renderPlaylist(segments: PlaylistSegment[]): string {
  if (segments.length === 0) {
    throw new Error('renderPlaylist: at least one segment is required');
  }
  const rounded = segments.map((s) => Math.max(1, Math.round(s.durationSec)));
  const target = Math.max(...rounded);
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${target}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ];
  for (const s of segments) {
    // EXTINF keeps the real (fractional) duration so seeking lines up; only
    // TARGETDURATION is integer by spec.
    lines.push(`#EXTINF:${formatDuration(s.durationSec)},`, s.url);
  }
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}

/** `3123` → `3123.0`, `479.987` → `479.987` — never more precision than ffmpeg gave. */
function formatDuration(sec: number): string {
  const d = Math.max(0.1, sec);
  return Number.isInteger(d) ? `${d}.0` : String(Math.round(d * 1000) / 1000);
}

/** Back-compat shape used by the single-file rows. */
export function renderSingleSegmentPlaylist(input: {
  segmentUrl: string;
  durationSec: number;
}): string {
  return renderPlaylist([{ url: input.segmentUrl, durationSec: input.durationSec }]);
}

export const HLS_PLAYLIST_CONTENT_TYPE = 'application/vnd.apple.mpegurl';
