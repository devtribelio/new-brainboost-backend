/**
 * Pure helpers for the audio migration job — kept apart from the job so they
 * can be tested without ffmpeg, Bunny or S3.
 */

export interface HlsPart {
  file: string;
  durationSec: number;
}

/**
 * Segment length (whole seconds) that yields AT MOST `parts` segments.
 *
 * Ceil, never round: ffmpeg's hls muxer closes a segment at the first packet
 * at or past `hls_time`, so every segment is slightly LONGER than asked and the
 * count can only come out ≤ parts. Rounding down is how 12 turns into 13 — a
 * second downloader batch, the exact thing the split exists to avoid.
 */
export function segmentSeconds(durationSec: number, parts: number): number {
  if (!(durationSec > 0) || !(parts >= 1)) throw new Error('segmentSeconds: bad input');
  return Math.max(1, Math.ceil(durationSec / parts));
}

/** Parts in play order from the media playlist ffmpeg wrote next to them. */
export function parseHlsParts(m3u8: string): HlsPart[] {
  const parts: HlsPart[] = [];
  let pending: number | null = null;
  for (const raw of m3u8.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) {
      const d = Number.parseFloat(line.slice(8).split(',')[0]);
      pending = Number.isFinite(d) ? d : null;
    } else if (line && !line.startsWith('#')) {
      if (pending === null || !(pending > 0)) throw new Error(`parseHlsParts: no duration for ${line}`);
      parts.push({ file: line, durationSec: Math.round(pending * 1000) / 1000 });
      pending = null;
    }
  }
  return parts;
}
