/**
 * Render an HLS media playlist whose whole content is ONE segment.
 *
 * Why a playlist at all, rather than handing the app the file URL: the mobile
 * app already in the stores only knows how to download "every segment listed
 * in the playlist" (`hls_download_service.dart`), and iOS hands the URL to
 * `AVAssetDownloadURLSession`. A one-segment playlist is valid HLS, so both
 * platforms fetch a single file with zero client change.
 *
 * Constraints that shape the output:
 *  - One segment without `EXT-X-MAP` is only valid for an elementary stream,
 *    hence `.aac` (ADTS). fMP4 would need an init segment.
 *  - `EXT-X-TARGETDURATION` must be >= the rounded segment duration.
 *  - The segment URI is absolute (S3 presigned or CloudFront signed); the app
 *    resolves it against the playlist URL and keeps the `.aac` extension so
 *    ExoPlayer picks the right extractor. Query strings are not part of the
 *    path, so signatures do not leak into the local filename.
 */
export function renderSingleSegmentPlaylist(input: {
  segmentUrl: string;
  durationSec: number;
}): string {
  const duration = Math.max(1, Math.round(input.durationSec));
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${duration}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXTINF:${duration}.0,`,
    input.segmentUrl,
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
}

export const HLS_PLAYLIST_CONTENT_TYPE = 'application/vnd.apple.mpegurl';
